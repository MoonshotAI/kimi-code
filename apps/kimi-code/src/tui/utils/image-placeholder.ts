/**
 * Scan submitted text for media placeholders and produce the prompt content
 * we'll send to the SDK prompt endpoint.
 *
 * `extractMediaAttachments` (sync) is the single expansion path for prompts:
 *   - image placeholders expand to inline image content parts. When the paste
 *     was uploaded to the daemon file store (`ImageAttachment.fileId`, v2
 *     engine only), the placeholder instead expands to a bare
 *     `kimi-file://<id>` image part — the engine's prompt intake materializes
 *     the session copy and rewrites the reference with its `?path=`, making
 *     the part self-contained (no paired tag is authored); without a `fileId`
 *     the inline base64 form is emitted unchanged (the only form the v1
 *     engine accepts). Compression captions for paste-time-downsampled images
 *     are NOT authored here: extraction runs before a first session exists,
 *     so `resolveOriginalCaptions` adds them at dispatch time, persisting the
 *     in-memory original (`ImageAttachment.original`) into the session's
 *     media-originals dir first;
 *   - video placeholders are copied into the shared cache (`getCacheDir()`)
 *     and expand to a `video_url` part pointing at the cache copy with a
 *     `file://` url. The v1 engine resolves that local reference inside the
 *     turn — uploading it (the `ms://` inline form) or degrading to a
 *     `<video path>` tag the model reads with `ReadMediaFile` — before the
 *     prompt lands in history.
 *
 * `rewriteMediaPlaceholders` is the separate text channel for slash-command
 * args (`/skill`, plugin commands): those are plain text, so media is rendered
 * as a `<video|image path="…">` tag / plain-text reference into cache-dir
 * copies the model opens with `ReadMediaFile`.
 *
 * Rules for both:
 *   - Only placeholders that resolve against `store` get extracted.
 *     A literal `[image #999 ...]` the user typed themselves stays in
 *     the text (we can't hallucinate files for it).
 *   - Order is preserved for text/image/video segments.
 *   - Adjacent text segments are flattened — empty / whitespace-only
 *     segments drop out so we never emit `{type:'text', text:' '}`
 *     noise between two media parts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PromptPart, Session } from '@moonshot-ai/kimi-code-sdk';
import {
  buildDaemonFileUrl,
  buildImageCompressionCaption,
  buildMediaPathTag,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/kimi-code-sdk';

import { getCacheDir } from '#/utils/paths';

import { IMAGE_FILE_REF_MIN_REMAINING_MS } from '../constant/media';
import type {
  ImageAttachment,
  ImageAttachmentStore,
  VideoAttachment,
} from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image|video) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;

export interface ExtractionResult {
  /** Flat list of parts in input order; empty array when no media matched. */
  parts: PromptPart[];
  /**
   * Did we find at least one matching attachment? When false, callers
   * should keep the prompt on the plain text path.
   */
  hasMedia: boolean;
  /** Image attachment ids matched, in the order they appeared. */
  imageAttachmentIds: number[];
  /** Video attachment ids matched, in the order they appeared. */
  videoAttachmentIds: number[];
  /**
   * Image bytes captured while extracting the prompt. A cache-hint resend can
   * outlive the attachment store and daemon file ids, so it uses these
   * snapshots to rebuild the image parts as inline data URLs.
   */
  imageSnapshots: ImageResendSnapshot[];
  /**
   * Cache copies staged by this submission. Lifecycle is owned by the
   * StagingLeaseTracker: deleted immediately when the submission is
   * abandoned, retired to session lifetime once a turn consumes them
   * (persisted history may still reference their paths).
   */
  stagingPaths: string[];
}

export interface ImageResendSnapshot {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /**
   * Pre-compression original captured at extraction, so a new-session resend
   * can still persist it and author the compression caption after the image
   * store (and its attachments) was cleared. Absent for untouched pastes and
   * for originals already persisted and released.
   */
  readonly original?: {
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly mime: string;
  };
}

export function extractMediaAttachments(
  text: string,
  store: ImageAttachmentStore,
): ExtractionResult {
  const parts: PromptPart[] = [];
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  const imageSnapshots: ImageResendSnapshot[] = [];
  const stagingPaths: string[] = [];
  let cursor = 0;
  let hasMedia = false;

  try {
    PLACEHOLDER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
      const [literal, kind, idStr] = match;
      if (kind !== 'image' && kind !== 'video') continue;
      if (idStr === undefined) continue;
      const id = Number.parseInt(idStr, 10);
      const attachment = store.get(id);
      if (attachment === undefined) continue; // stale / user-typed — leave as text
      if (attachment.kind !== kind) continue;
      const before = text.slice(cursor, match.index);
      pushText(parts, before);
      if (attachment.kind === 'video') {
        // Copy the paste into the shared cache and reference it by a `file://`
        // url; the engine resolves (uploads or degrades) it inside the turn.
        const cachePath = materializeVideoToCache(attachment);
        stagingPaths.push(cachePath);
        parts.push(videoPartForCachePath(cachePath));
        videoAttachmentIds.push(id);
      } else {
        const original = attachment.original;
        imageSnapshots.push({
          bytes: attachment.bytes,
          mime: attachment.mime,
          width: attachment.width,
          height: attachment.height,
          original:
            original?.bytes === undefined
              ? undefined
              : {
                  bytes: original.bytes,
                  width: original.width,
                  height: original.height,
                  mime: original.mime,
                },
        });
        // No compression caption here: `resolveOriginalCaptions` authors it
        // at dispatch time, once the session (and its media-originals dir)
        // is known.
        if (attachment.fileId !== undefined) {
          // The bytes were uploaded to the daemon file store at paste time
          // (v2): reference them by a bare `kimi-file://` url — the engine's
          // prompt intake materializes the session copy and rewrites the
          // reference with its `?path=`, so the edge stages no local copy.
          parts.push({
            type: 'image_url',
            imageUrl: { url: buildDaemonFileUrl(attachment.fileId) },
          });
        } else {
          parts.push(imagePartForAttachment(attachment));
        }
        imageAttachmentIds.push(id);
      }
      hasMedia = true;
      cursor = match.index + literal.length;
    }
    const tail = text.slice(cursor);
    pushText(parts, tail);

    store.retainFileIds(imageAttachmentIds);
    const freshParts = refreshExpiringImageFileRefs(parts, imageAttachmentIds, store);
    return {
      // Text-only submissions drop the synthesised parts array — the
      // caller's contract is "parts is meaningful iff hasMedia", and
      // emitting a stray TextPart confuses consumers that branch on
      // `parts.length > 0`.
      parts: hasMedia ? freshParts : [],
      hasMedia,
      imageAttachmentIds,
      videoAttachmentIds,
      imageSnapshots,
      stagingPaths,
    };
  } catch (error) {
    cleanupStagingPaths(stagingPaths);
    throw error;
  }
}

/**
 * The video attachment ids referenced by `text`, in placeholder order — the
 * same order extraction staged their cache copies in, so callers can zip the
 * result with a submission's `stagingPaths`.
 */
export function videoAttachmentIdsInText(text: string, store: ImageAttachmentStore): number[] {
  const ids: number[] = [];
  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [, kind, idStr] = match;
    if (kind !== 'video' || idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    if (store.get(id)?.kind === 'video') ids.push(id);
  }
  return ids;
}

/**
 * Give images referenced by `text` a bounded moment to finish their
 * background paste ingestion (compression/upload — see `ImageAttachment.pending`)
 * before extraction, so a paste-then-immediately-submit still expands to the
 * compressed/daemon-ref form. The returned promise resolves after `timeoutMs`
 * at the latest; whatever has not landed by then simply extracts to the
 * inline fallback form. Returns undefined when nothing is pending, so the
 * submit path stays synchronous for media-free prompts.
 */
export function pendingImageIngestions(
  text: string,
  store: ImageAttachmentStore,
  timeoutMs: number,
): Promise<void> | undefined {
  const pendings: Promise<void>[] = [];
  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [, kind, idStr] = match;
    if (kind !== 'image' || idStr === undefined) continue;
    const attachment = store.get(Number.parseInt(idStr, 10));
    if (attachment?.kind === 'image' && attachment.pending !== undefined) {
      pendings.push(attachment.pending);
    }
  }
  if (pendings.length === 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.allSettled(pendings).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Replace daemon refs that may expire before validation reaches the server
 * with the attachment's retained bytes. Called both at extraction time and
 * again when a queued/cache-hint submission is actually dispatched.
 */
export function refreshExpiringImageFileRefs(
  parts: readonly PromptPart[],
  imageAttachmentIds: readonly number[],
  store: ImageAttachmentStore,
  now = Date.now(),
): PromptPart[] {
  if (imageAttachmentIds.length === 0) return [...parts];
  let imageIndex = 0;
  let changed = false;
  const next = parts.map((part) => {
    if (part.type !== 'image_url') return part;
    const attachmentId = imageAttachmentIds[imageIndex++];
    if (attachmentId === undefined || !part.imageUrl.url.startsWith('kimi-file://')) return part;
    const attachment = store.get(attachmentId);
    if (attachment?.kind !== 'image') return part;

    const fileId = attachment.fileId;
    const expiresAt = attachment.fileExpiresAt;
    const usable =
      fileId !== undefined &&
      (expiresAt === undefined || expiresAt - now > IMAGE_FILE_REF_MIN_REMAINING_MS);
    if (usable) {
      const url = buildDaemonFileUrl(fileId);
      if (url === part.imageUrl.url) return part;
      changed = true;
      return { ...part, imageUrl: { ...part.imageUrl, url } };
    }

    attachment.fileId = undefined;
    attachment.fileExpiresAt = undefined;
    changed = true;
    return imagePartForAttachment(attachment);
  });
  return changed ? next : [...parts];
}

/**
 * Make an extraction safe to resend after a session reset. The reset clears
 * the image store and deletes daemon file ids, so uploaded image refs must be
 * replaced with the bytes captured during the original extraction. Cache
 * paths are intentionally preserved: they are carried by the resend's new
 * staging lease and remain available to any path tag in the prompt.
 *
 * Snapshots of compressed pastes also carry the pre-compression original: the
 * cleared store took the attachment with it, so dispatch-time caption
 * resolution can no longer find either. `makeExtractionResendable` persists
 * that original into `originalsDir` (the NEW session's media-originals dir;
 * temp-dir fallback when undefined) and authors the compression caption
 * itself, right before the rebuilt image part.
 */
export function makeExtractionResendable(
  extraction: ExtractionResult,
  originalsDir?: string,
): ExtractionResult {
  if (extraction.imageSnapshots.length === 0) return extraction;

  let imageIndex = 0;
  const parts: PromptPart[] = [];
  for (const part of extraction.parts) {
    if (part.type !== 'image_url') {
      parts.push(part);
      continue;
    }
    const snapshot = extraction.imageSnapshots[imageIndex++];
    const original = snapshot?.original;
    if (snapshot !== undefined && original !== undefined) {
      parts.push({
        type: 'text',
        text: buildImageCompressionCaption({
          original: {
            width: original.width,
            height: original.height,
            byteLength: original.bytes.length,
            mimeType: original.mime,
          },
          final: {
            width: snapshot.width,
            height: snapshot.height,
            byteLength: snapshot.bytes.length,
            mimeType: snapshot.mime,
          },
          originalPath: persistOriginalImageSync(original.bytes, original.mime, originalsDir),
        }),
      });
    }
    if (snapshot === undefined || !part.imageUrl.url.startsWith('kimi-file://')) {
      parts.push(part);
      continue;
    }
    parts.push({
      ...part,
      imageUrl: {
        ...part.imageUrl,
        url: `data:${snapshot.mime};base64,${Buffer.from(snapshot.bytes).toString('base64')}`,
      },
    });
  }

  return {
    ...extraction,
    parts,
    // The new session's store no longer contains these ids. The rebuilt parts
    // carry their own bytes, so keeping stale ids would break thumbnail and
    // later cleanup lookups.
    imageAttachmentIds: [],
  };
}

export interface MediaTagRewriteResult {
  /** Input text with resolved placeholders replaced by media references. */
  text: string;
  hasMedia: boolean;
  imageAttachmentIds: number[];
  videoAttachmentIds: number[];
  stagingPaths: string[];
}

/**
 * How a resolved placeholder is rendered into command args:
 *  - `'tag'`: the `<image|video path="…"></…>` convention, for channels
 *    that pass args through verbatim (plugin commands).
 *  - `'plain'`: a plain-text file reference with no XML tag/attribute
 *    boundary characters, for channels that XML-escape args (`/skill`
 *    args are escaped by both `renderSkillAttributes` and
 *    `expandSkillParameters`, which would mangle the tag form).
 */
export type MediaReferenceStyle = 'tag' | 'plain';

/**
 * Rewrite media placeholders in slash-command args (`/skill:foo …`,
 * plugin commands) into references pointing at cache-dir copies. Command
 * args are a plain-text channel — unlike `extractMediaAttachments`, which
 * inlines image parts for the prompt endpoint — so the model reaches the
 * media through `ReadMediaFile` instead, the same way it already handles
 * pasted videos.
 *
 * Surrounding text is preserved verbatim (args are user content, not
 * LLM parts), and unresolved placeholders stay literal.
 */
export function rewriteMediaPlaceholders(
  text: string,
  store: ImageAttachmentStore,
  style: MediaReferenceStyle = 'tag',
): MediaTagRewriteResult {
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  const stagingPaths: string[] = [];
  let cursor = 0;
  let out = '';

  try {
    PLACEHOLDER_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
      const [literal, kind, idStr] = match;
      if (kind !== 'image' && kind !== 'video') continue;
      if (idStr === undefined) continue;
      const id = Number.parseInt(idStr, 10);
      const attachment = store.get(id);
      if (attachment === undefined) continue; // stale / user-typed — leave as text
      if (attachment.kind !== kind) continue;
      out += text.slice(cursor, match.index);
      if (attachment.kind === 'video') {
        const path = materializeVideoToCache(attachment, style === 'plain');
        stagingPaths.push(path);
        out +=
          style === 'plain'
            ? formatMediaReference('video', path)
            : buildMediaPathTag('video', path);
        videoAttachmentIds.push(id);
      } else {
        const path = materializeImageToCache(attachment);
        stagingPaths.push(path);
        out +=
          style === 'plain'
            ? formatMediaReference('image', path)
            : buildMediaPathTag('image', path);
        imageAttachmentIds.push(id);
      }
      cursor = match.index + literal.length;
    }

    const hasMedia = imageAttachmentIds.length + videoAttachmentIds.length > 0;
    store.retainFileIds(imageAttachmentIds);
    return {
      text: hasMedia ? out + text.slice(cursor) : text,
      hasMedia,
      imageAttachmentIds,
      videoAttachmentIds,
      stagingPaths,
    };
  } catch (error) {
    cleanupStagingPaths(stagingPaths);
    throw error;
  }
}

function cleanupStagingPaths(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort: a failed copy may not have created the target.
    }
  }
}

function pushText(parts: PromptPart[], segment: string): void {
  if (segment.length === 0) return;
  // Keep whitespace-only segments only when they sit between non-empty
  // text elsewhere — the simpler rule "drop everything whitespace-only"
  // is fine here because the LLM doesn't care about inter-image spaces.
  if (segment.trim().length === 0) return;
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + segment };
    return;
  }
  parts.push({ type: 'text', text: segment });
}

function imagePartForAttachment(att: ImageAttachment): Extract<PromptPart, { type: 'image_url' }> {
  const base64 = Buffer.from(att.bytes).toString('base64');
  return {
    type: 'image_url',
    imageUrl: { url: `data:${att.mime};base64,${base64}` },
  };
}

/**
 * Is this image part still what the attachment holds? Extraction encodes the
 * attachment as of extraction time; a paste whose background ingestion
 * (compression/daemon upload) landed afterwards mutated it, leaving the part
 * carrying the pre-compression form — which no caption may describe.
 */
function imagePartMatchesAttachment(
  part: Extract<PromptPart, { type: 'image_url' }>,
  attachment: ImageAttachment,
): boolean {
  const url = part.imageUrl.url;
  if (url.startsWith('kimi-file://')) {
    return attachment.fileId !== undefined && url === buildDaemonFileUrl(attachment.fileId);
  }
  return url === imagePartForAttachment(attachment).imageUrl.url;
}

/**
 * A `video_url` prompt part pointing at a cache copy by `file://` url. The v1
 * engine resolves the local reference in-turn (upload → `ms://`, or degrade to
 * a `<video path>` tag) before it reaches the model or the persisted history.
 */
function videoPartForCachePath(cachePath: string): PromptPart {
  return {
    type: 'video_url',
    videoUrl: { url: pathToFileURL(cachePath).href },
  };
}

function materializeVideoToCache(att: VideoAttachment, escapeProofName = false): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  // The label permits XML boundary chars (`<>&"`); plain references go
  // through skill-arg escaping, where they would no longer match the file
  // on disk, so strip them from the cache name in that mode.
  const label = escapeProofName ? att.label.replaceAll(/[<>&"]/g, '_') : att.label;
  const target = join(cacheDir, `${randomUUID()}-${label}`);
  copyFileSync(att.sourcePath, target);
  return target;
}

const IMAGE_MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

/**
 * File-extension hint for an image MIME (`image/png` → `png`). The real
 * format is always sniffed from the bytes, so this only names files (cache
 * copies, daemon upload labels).
 */
export function imageExtensionForMime(mime: string): string {
  return IMAGE_MIME_EXTENSION[mime.trim().toLowerCase()] ?? 'img';
}

function materializeImageToCache(att: ImageAttachment): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  // ReadMediaFile sniffs the real format from the bytes, so the extension
  // only needs to be a reasonable hint.
  const target = join(cacheDir, `${randomUUID()}.${imageExtensionForMime(att.mime)}`);
  writeFileSync(target, att.bytes);
  return target;
}

/** Opening every compression caption starts with (see buildImageCompressionCaption). */
const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

/**
 * The session-owned originals store for compression captions, when the
 * session's dir is known; undefined falls back to the shared temp dir.
 */
export function originalsDirForSession(session: Session | undefined): string | undefined {
  const sessionDir = session?.summary?.sessionDir;
  return sessionDir === undefined ? undefined : sessionMediaOriginalsDir(sessionDir);
}

/**
 * Author a compression caption before every referenced image whose paste-time
 * compression shrank the bytes, persisting not-yet-persisted originals into
 * `originalsDir` (the session's media-originals dir; the shared temp-dir
 * fallback when undefined) so the caption points at a real readback path.
 *
 * Extraction deliberately does not do this: it can run before the session
 * exists (first submit creates it lazily), and the original belongs with the
 * session — owned by it, cleaned up with it, immune to OS temp reaping. The
 * dispatch paths call this once the session is known. Synchronous because
 * those paths cannot await; the write is a single small file, same as the
 * cache copies extraction itself stages. Idempotent: an image already
 * preceded by a compression caption gets it refreshed in place, so a
 * re-resolved part list never grows a duplicate.
 */
export function resolveOriginalCaptions(
  parts: readonly PromptPart[],
  imageAttachmentIds: readonly number[],
  store: ImageAttachmentStore,
  originalsDir: string | undefined,
): PromptPart[] {
  let imageIndex = 0;
  let changed = false;
  const out: PromptPart[] = [];
  for (const part of parts) {
    if (part.type !== 'image_url') {
      out.push(part);
      continue;
    }
    const attachmentId = imageAttachmentIds[imageIndex++];
    const attachment = attachmentId === undefined ? undefined : store.get(attachmentId);
    if (attachment?.kind !== 'image' || attachment.original === undefined) {
      out.push(part);
      continue;
    }
    // The part was encoded from the attachment at extraction; a paste whose
    // background ingestion landed afterwards mutated it (compressed bytes,
    // daemon file id), leaving the part carrying the pre-compression form.
    // Caption only when the two still agree — otherwise the caption would
    // describe an image the model did not receive.
    if (!imagePartMatchesAttachment(part, attachment)) {
      out.push(part);
      continue;
    }
    const original = attachment.original;
    if (original.path === undefined && original.bytes !== undefined) {
      // A persistence failure (unwritable dir, full disk) leaves the path
      // unset — and the bytes retained — so a later dispatch retries; this
      // dispatch captions without a readback path.
      const path = persistOriginalImageSync(original.bytes, original.mime, originalsDir);
      if (path !== null) store.setOriginalPath(attachment.id, path);
    }
    const caption = buildImageCompressionCaption({
      original: {
        width: original.width,
        height: original.height,
        byteLength: original.byteLength,
        mimeType: original.mime,
      },
      final: {
        width: attachment.width,
        height: attachment.height,
        byteLength: attachment.bytes.length,
        mimeType: attachment.mime,
      },
      originalPath: original.path,
    });
    const previous = out.at(-1);
    if (previous?.type === 'text' && previous.text.startsWith(CAPTION_OPENING)) {
      out[out.length - 1] = { type: 'text', text: caption };
    } else {
      out.push({ type: 'text', text: caption });
    }
    changed = true;
    out.push(part);
  }
  return changed ? out : [...parts];
}

/**
 * Synchronous twin of the engine's `persistOriginalImage` — same
 * content-addressed naming and the same size-capped eviction: the dispatch
 * paths that resolve captions cannot await. Exported for tests; production
 * callers go through `resolveOriginalCaptions` / `makeExtractionResendable`.
 */
export function persistOriginalImageSync(
  bytes: Uint8Array,
  mime: string,
  dir: string | undefined,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
): string | null {
  if (bytes.length === 0) return null;
  try {
    const targetDir = dir ?? originalImageTempDir();
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const target = join(targetDir, `${hash}.${imageExtensionForMime(mime)}`);
    mkdirSync(targetDir, { recursive: true });
    const existing = statSync(target, { throwIfNoEntry: false });
    // Content-addressed: an existing entry with the right size IS this image.
    if (existing === undefined || existing.size !== bytes.length) {
      writeFileSync(target, bytes);
    }
    sweepCacheSync(targetDir, maxTotalBytes);
    // The just-written file may itself have been evicted by the sweep when a
    // single original exceeds the cap; report persistence honestly.
    return statSync(target, { throwIfNoEntry: false }) === undefined ? null : target;
  } catch {
    return null;
  }
}

/** Per-store ceiling; mirrors the engine originals store. */
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Evict oldest files (by mtime) until the store fits `maxTotalBytes`. */
function sweepCacheSync(dir: string, maxTotalBytes: number): void {
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path, { throwIfNoEntry: false });
    if (info === undefined || !info.isFile()) continue;
    entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxTotalBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxTotalBytes) break;
    try {
      unlinkSync(entry.path);
      total -= entry.size;
    } catch {
      // Best effort, mirroring the async twin.
    }
  }
}

/** Mirrors agent-core's `originalImageCacheDir` (not re-exported through the SDK). */
function originalImageTempDir(): string {
  return join(tmpdir(), 'kimi-code-original-images');
}

/**
 * Plain-text media reference for channels that XML-escape args (`/skill`).
 * Free of `& < > "` (UUID image names; boundary chars stripped from video
 * cache names — see materializeVideoToCache) so it survives
 * `escapeXml`/`escapeXmlTags` untouched.
 */
function formatMediaReference(kind: 'image' | 'video', path: string): string {
  return `Attached ${kind} file: ${path} (open it with ReadMediaFile)`;
}
