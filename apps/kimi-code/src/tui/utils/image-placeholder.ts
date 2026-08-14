/**
 * Scan submitted text for media placeholders and produce the prompt content
 * we'll send to the SDK prompt endpoint.
 *
 * `extractMediaAttachments` (sync) is the single expansion path for prompts:
 *   - image placeholders expand to inline image content parts (preceded by a
 *     compression caption when paste-time compression shrank the bytes — see
 *     `ImageAttachment.original`). When the paste was uploaded to the daemon
 *     file store (`ImageAttachment.fileId`, v2 engine only), the placeholder
 *     instead expands to a bare `kimi-file://<id>` image part — the engine's
 *     prompt intake materializes the session copy and rewrites the reference
 *     with its `?path=`, making the part self-contained (no paired tag is
 *     authored); without a `fileId` the inline base64 form is emitted
 *     unchanged (the only form the v1 engine accepts);
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

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';
import {
  buildDaemonFileUrl,
  buildImageCompressionCaption,
  buildMediaPathTag,
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
        imageSnapshots.push({ bytes: attachment.bytes, mime: attachment.mime });
        // Paste-time compression is announced next to the image so the model
        // knows it received a downsampled copy and where the original lives.
        if (attachment.original !== undefined) {
          pushText(parts, captionForCompressedImage(attachment));
        }
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
 */
export function makeExtractionResendable(extraction: ExtractionResult): ExtractionResult {
  if (extraction.imageSnapshots.length === 0) return extraction;

  let imageIndex = 0;
  const parts = extraction.parts.map((part) => {
    if (part.type !== 'image_url') return part;
    const snapshot = extraction.imageSnapshots[imageIndex++];
    if (snapshot === undefined || !part.imageUrl.url.startsWith('kimi-file://')) return part;
    return {
      ...part,
      imageUrl: {
        ...part.imageUrl,
        url: `data:${snapshot.mime};base64,${Buffer.from(snapshot.bytes).toString('base64')}`,
      },
    };
  });

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

function imagePartForAttachment(att: ImageAttachment): PromptPart {
  const base64 = Buffer.from(att.bytes).toString('base64');
  return {
    type: 'image_url',
    imageUrl: { url: `data:${att.mime};base64,${base64}` },
  };
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

function captionForCompressedImage(att: ImageAttachment): string {
  const original = att.original;
  if (original === undefined) return '';
  return buildImageCompressionCaption({
    original: {
      width: original.width,
      height: original.height,
      byteLength: original.byteLength,
      mimeType: original.mime,
    },
    final: {
      width: att.width,
      height: att.height,
      byteLength: att.bytes.length,
      mimeType: att.mime,
    },
    originalPath: original.path,
  });
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
