/**
 * Prompt media/attachment pipeline shared by the prompt-submission and
 * skill-activation edges.
 *
 * Four stages, in the order both routes apply them:
 *   1. `assertPromptFileRefs` — fail fast on stale or mis-kinded `file_id`
 *      references before anything session-scoped is resolved or mutated.
 *   2. `assertPromptSessionMediaRefs` — validate canonical session media
 *      references before anything session-scoped is resolved or mutated.
 *   3. `resolvePromptMediaFiles` — resolve uploads into their context form:
 *      arbitrary files become path-referenced attachments (a text notice the
 *      model opens with the Read tool), images are format-gated and
 *      compressed, and image/video uploads enter context as bare internal
 *      `kimi-file://` references the engine's prompt intake materializes.
 *   4. `contentToCoreParts` — project the resolved wire content onto engine
 *      `ContentPart`s.
 *
 * Extracted from `routes/prompts.ts` so `routes/skills.ts` can run the exact
 * same pipeline for skill-activation attachments.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  buildDaemonFileUrl,
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressBase64ForModel,
  compressImageForModel,
  decodeBase64Prefix,
  Error2,
  fileNotFoundError,
  isModelAcceptedImageMime,
  normalizeImageMime,
  persistOriginalImage,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
  type ContentPart,
  type GetResult,
  type IFileService,
  type ISessionMediaStore,
  type ImageCompressionTelemetry,
  type ITelemetryService,
} from '@moonshot-ai/agent-core-v2';

import type { PromptSubmission } from '../protocol/rest-prompt';

/**
 * The content list these helpers walk. Routes pass their own wire content:
 * the full prompt submission's `content`, or a skill activation's
 * `attachments` (same `MessageContent` parts, minus the text-ish kinds).
 */
type WireContent = PromptSubmission['content'];

/**
 * Fail fast on stale or mis-kinded file references before anything
 * session-scoped happens: a bad `file_id` (unknown, or a real file used with
 * the wrong media kind, e.g. a PDF submitted as a video) must reject the
 * request without creating the prompt agent and without touching the
 * session's model/thinking/permission.
 */
export async function assertPromptFileRefs(content: WireContent, store: IFileService): Promise<void> {
  for (const part of content) {
    if (part.type === 'file') {
      await store.get(part.file_id);
    } else if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'file') {
      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
    }
  }
}

/**
 * Fail fast on stale `session_media` references: a file id with no canonical
 * copy in this session must reject the request before anything is resolved
 * or mutated.
 */
export async function assertPromptSessionMediaRefs(
  content: WireContent,
  store: ISessionMediaStore,
): Promise<void> {
  for (const part of content) {
    if (
      (part.type !== 'image' && part.type !== 'video') ||
      part.source.kind !== 'session_media'
    ) continue;
    const file = await store.open(part.source.file_id);
    if (file === undefined) throw fileNotFoundError(part.source.file_id);
  }
}

export function contentToCoreParts(content: WireContent): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image' && part.source.kind === 'url') parts.push({ type: 'image_url', imageUrl: { url: part.source.url, id: part.source.id } });
    else if (part.type === 'image' && part.source.kind === 'base64') parts.push({ type: 'image_url', imageUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
    else if (part.type === 'image' && part.source.kind === 'session_media') parts.push({ type: 'image_url', imageUrl: { url: buildDaemonFileUrl(part.source.file_id) } });
    else if (part.type === 'video' && part.source.kind === 'url') parts.push({ type: 'video_url', videoUrl: { url: part.source.url, id: part.source.id } });
    else if (part.type === 'video' && part.source.kind === 'base64') parts.push({ type: 'video_url', videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
    else if (part.type === 'video' && part.source.kind === 'session_media') parts.push({ type: 'video_url', videoUrl: { url: buildDaemonFileUrl(part.source.file_id) } });
  }
  return parts;
}

export interface ResolvePromptMediaOptions {
  /**
   * Lazily resolve the session's media-originals dir for persisting the
   * pre-compression bytes of inline base64 images. Only invoked when an image
   * was actually compressed; a failure or undefined result falls back to the
   * shared temp-dir cache.
   */
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  /**
   * Lazily resolve the session's attachments dir for materializing arbitrary
   * file uploads (and image bytes the provider rejects) into a path the model
   * can open with the Read tool. A failure or undefined result falls back to
   * the shared cache dir.
   */
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
  /** Report an `image_compress` event per compressed prompt image. */
  readonly telemetry?: ITelemetryService;
}

export interface PromptMediaPreparation {
  readonly content: WireContent;
  /**
   * Delete the transient daemon uploads this preparation created (the
   * compressed re-save). Call on failure, or after the engine has either
   * materialized the Session-owned copy or terminally rejected the prompt.
   */
  readonly discard: () => Promise<void>;
}

/**
 * Resolve a wire content list's media/file references into their final wire
 * form: uploaded files materialize to a session-local path notice, images are
 * format-gated and compressed, and image/video uploads enter context as bare
 * internal `kimi-file://` references. The preparation's `content` is the
 * input array unchanged when nothing needed resolving; `discard` rolls back
 * or releases the daemon uploads the preparation created after intake.
 */
export async function resolvePromptMediaFiles(
  input: WireContent,
  store: IFileService,
  cacheDir: string,
  options: ResolvePromptMediaOptions = {},
): Promise<PromptMediaPreparation> {
  const ownedFileIds = new Set<string>();
  let discarded = false;
  const discard = async (): Promise<void> => {
    if (discarded) return;
    discarded = true;
    await Promise.all(
      [...ownedFileIds].map((fileId) => store.delete(fileId).catch(() => undefined)),
    );
  };
  let changed = false;
  let originalsDir: string | undefined;
  let originalsDirResolved = false;
  const resolveOriginalsDir = async (): Promise<string | undefined> => {
    if (!originalsDirResolved) {
      originalsDirResolved = true;
      originalsDir = await options.resolveOriginalsDir?.().catch(() => undefined);
    }
    return originalsDir;
  };
  let attachmentsDir: string | undefined;
  let attachmentsDirResolved = false;
  const resolveAttachmentsDir = async (): Promise<string> => {
    if (!attachmentsDirResolved) {
      attachmentsDirResolved = true;
      attachmentsDir = await options.resolveAttachmentsDir?.().catch(() => undefined);
    }
    return attachmentsDir ?? cacheDir;
  };
  const telemetryFor = (source: string): ImageCompressionTelemetry | undefined =>
    options.telemetry === undefined ? undefined : { client: options.telemetry, source };
  const content: WireContent = [];
  try {
    for (const part of input) {
      // Inline base64 image: compress the payload in place. This mirrors the v1
      // server path for REST clients that submit an image without uploading it.
      if (part.type === 'image' && part.source.kind === 'base64') {
        // Formats the provider cannot accept must never enter the session
        // history — one unsupported image_url makes every later request fail.
        // The bytes are authoritative: an image labeled image/png that is
        // actually AVIF is gated on the sniffed format, not the label. The
        // bytes are still the user's content, though: persist them as a
        // path-referenced attachment so the model can read and convert them
        // itself (best effort — the plain notice stands in when persisting
        // fails). Inline base64 has no original name, so the file is addressed
        // by content hash with a name derived from the sniffed format.
        const effectiveMime = resolveEffectiveImageMime(
          part.source.media_type,
          decodeBase64Prefix(part.source.data),
        );
        if (!isModelAcceptedImageMime(effectiveMime)) {
          const bytes = Buffer.from(part.source.data, 'base64');
          const name = `image.${imageExtensionForMime(effectiveMime)}`;
          const persisted = await persistAttachmentBytes(
            bytes,
            `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}-${name}`,
            await resolveAttachmentsDir(),
          );
          content.push({
            type: 'text',
            text: persisted === null
              ? buildUnsupportedImageNotice(effectiveMime)
              : buildAttachedFileNotice(name, effectiveMime, bytes.length, persisted),
          });
          changed = true;
          continue;
        }
        const canonicalMime = normalizeImageMime(effectiveMime);
        const compressed = await compressBase64ForModel(part.source.data, canonicalMime, {
          telemetry: telemetryFor('prompt_inline'),
        });
        if (compressed.changed) {
          const dir = await resolveOriginalsDir();
          const originalPath = await persistOriginalImage(
            Buffer.from(part.source.data, 'base64'),
            part.source.media_type,
            { dir },
          );
          content.push({
            type: 'text',
            text: buildImageCompressionCaption({
              original: {
                width: compressed.originalWidth,
                height: compressed.originalHeight,
                byteLength: compressed.originalByteLength,
                mimeType: part.source.media_type,
              },
              final: {
                width: compressed.width,
                height: compressed.height,
                byteLength: compressed.finalByteLength,
                mimeType: compressed.mimeType,
              },
              originalPath,
            }),
          });
          content.push({
            type: 'image',
            source: { kind: 'base64', media_type: compressed.mimeType, data: compressed.base64 },
          });
          changed = true;
        } else {
          content.push(part);
        }
        continue;
      }

      // Remote image URL: no bytes to sniff, so reject when its path extension
      // names a format providers reject (e.g. a link ending in `.avif`) — the
      // notice keeps the URL so the model can still fetch and convert the
      // image. Extensionless / unknown URLs pass through to the provider and
      // the 400 recovery. Image+URL parts that pass are re-emitted unchanged.
      if (part.type === 'image' && part.source.kind === 'url') {
        const extMime = unsupportedImageMimeFromUrl(part.source.url);
        if (extMime !== null) {
          content.push({ type: 'text', text: buildUnsupportedImageNotice(extMime, part.source.url) });
          changed = true;
          continue;
        }
        content.push(part);
        continue;
      }

      // Arbitrary file attachment: materialize the uploaded bytes next to the
      // session and replace the part with a path reference — the model opens it
      // with the Read tool instead of receiving it as a media part.
      if (part.type === 'file') {
        const file = await store.get(part.file_id);
        const attachedPath = await materializeAttachmentToDir(file, await resolveAttachmentsDir());
        content.push({
          type: 'text',
          text: buildAttachedFileNotice(file.meta.name, file.meta.media_type, file.meta.size, attachedPath),
        });
        changed = true;
        continue;
      }

      if ((part.type !== 'image' && part.type !== 'video') || part.source.kind !== 'file') {
        content.push(part);
        continue;
      }

      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
      if (part.type === 'image') {
        const data = await readFileOrStream(file);
        let mediaType = file.meta.media_type;
        // Same format gate as the inline path above, and again the bytes are
        // authoritative: an upload whose Content-Type lies (AVIF bytes sent
        // as image/png) is gated on the sniffed format. Like the inline path,
        // keep the bytes as a path-referenced attachment instead of dropping
        // them (best effort — the plain notice stands in when persisting
        // fails).
        mediaType = resolveEffectiveImageMime(mediaType, data);
        if (!isModelAcceptedImageMime(mediaType)) {
          const persisted = await persistAttachmentBytes(
            data,
            `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`,
            await resolveAttachmentsDir(),
          );
          content.push({
            type: 'text',
            text: persisted === null
              ? buildUnsupportedImageNotice(mediaType, file.meta.name)
              : buildAttachedFileNotice(file.meta.name, mediaType, file.meta.size, persisted),
          });
          changed = true;
          continue;
        }
        // Forward the canonical MIME (image/jpg → image/jpeg, case/whitespace)
        // — strict provider whitelists reject the raw alias.
        mediaType = normalizeImageMime(mediaType);
        const compressed = await compressImageForModel(data, mediaType, {
          telemetry: telemetryFor('prompt_file'),
        });
        if (compressed.changed) {
          const dir = await resolveOriginalsDir();
          const originalPath = await persistOriginalImage(data, mediaType, { dir });
          content.push({
            type: 'text',
            text: buildImageCompressionCaption({
              original: {
                width: compressed.originalWidth,
                height: compressed.originalHeight,
                byteLength: compressed.originalByteLength,
                mimeType: mediaType,
              },
              final: {
                width: compressed.width,
                height: compressed.height,
                byteLength: compressed.finalByteLength,
                mimeType: compressed.mimeType,
              },
              originalPath,
            }),
          });
        }
        // Like an uploaded video, the image enters context as a bare internal
        // `kimi-file://<id>` reference: the engine's prompt intake
        // materializes the session-canonical copy and resolves the reference
        // at request time.
        // When compression changed the bytes, the reference addresses a NEW
        // daemon upload holding the final bytes — the client's original
        // upload stays untouched. The re-save is staging only: read models
        // project the Session-owned copy, and the route releases this upload
        // after intake or terminal rejection.
        let finalFile = file;
        if (compressed.changed) {
          const saved = await store.save(
            Readable.from(Buffer.from(compressed.data)),
            compressedUploadName(file.meta.name, compressed.mimeType),
            { mimeType: compressed.mimeType },
          );
          // Owned until the content reaches the engine: a preparation failure
          // rolls the re-save back; successful submission releases it once
          // intake has materialized the Session-owned copy.
          ownedFileIds.add(saved.id);
          finalFile = await store.get(saved.id);
        }
        content.push({
          type: 'image',
          source: { kind: 'url', url: buildDaemonFileUrl(finalFile.meta.id) },
        });
        changed = true;
        continue;
      }

      // Uploaded video: carried into context as a bare internal
      // `kimi-file://<id>` reference. The engine's prompt intake materializes
      // the session copy, then resolves the reference to a provider form
      // (upload / inline / tag) at request time, so the edge never uploads
      // and never blocks on the provider.
      content.push({
        type: 'video',
        source: { kind: 'url', url: buildDaemonFileUrl(file.meta.id) },
      });
      changed = true;
    }
    return { content: changed ? content : input, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

/**
 * Name for the daemon upload holding compressed image bytes: keep the
 * original base name but take the extension from the final MIME, since the
 * encoder may have switched formats (png ↔ jpeg).
 */
function compressedUploadName(originalName: string, mimeType: string): string {
  const base = originalName.replace(/\.[^./\\]*$/, '');
  return `${base.length > 0 ? base : 'image'}.${imageExtensionForMime(mimeType)}`;
}

const ATTACHMENT_NAME_MAX = 100;

/**
 * Attachment file names are untrusted (the multipart filename / a wire field):
 * strip path separators, control chars, and leading dots so the materialized
 * file can never escape its directory or land as a hidden file, and cap the
 * length so the path stays manageable.
 */
function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replaceAll(/[\\/]/g, '_')
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/** Stream an uploaded file into `dir` as `<fileId>-<sanitized name>`. */
async function materializeAttachmentToDir(file: GetResult, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

/**
 * Write already-buffered attachment bytes into `dir` under `name` (the caller
 * builds the name: file-id or content-hash prefixed). Best effort — returns
 * null instead of throwing so a prompt never fails over the persisted copy.
 */
async function persistAttachmentBytes(
  bytes: Uint8Array,
  name: string,
  dir: string,
): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true });
    const target = join(dir, name);
    const info = await stat(target).catch(() => undefined);
    if (info?.size !== bytes.length) await writeFile(target, bytes);
    return target;
  } catch {
    return null;
  }
}

/** Derive a file extension from an image MIME (`image/svg+xml` → `svg`). */
function imageExtensionForMime(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase().split('+')[0] ?? '';
  const ext = subtype.replaceAll(/[^a-z0-9-]/g, '');
  return ext.length > 0 ? ext : 'img';
}

// This notice's exact shape is a client contract: kimi-web's messagesToTurns
// parses it (ATTACHED_FILE_NOTICE_RE) to rebuild the attachment chip after a
// resync — change the wording there too.
function buildAttachedFileNotice(name: string, mediaType: string, size: number, path: string): string {
  return `Attached file "${name}" (${mediaType}, ${size} bytes): ${path} — open it with the Read tool`;
}

async function readFileOrStream(file: GetResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream()) {
    chunks.push(Buffer.from(chunk as string | Uint8Array));
  }
  return Buffer.concat(chunks);
}

function assertMediaFile(file: GetResult, expected: 'image' | 'video'): void {
  const prefix = expected === 'video' ? 'video/' : 'image/';
  if (file.meta.media_type.toLowerCase().startsWith(prefix)) return;
  throw new Error2(
    'validation.failed',
    `file ${file.meta.id} is ${file.meta.media_type}, not ${expected === 'video' ? 'a video' : 'an image'}`,
  );
}
