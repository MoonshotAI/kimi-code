import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptPart, Session } from '@moonshot-ai/kimi-code-sdk';
import {
  buildDaemonFileUrl,
  buildImageCompressionCaption,
  buildMediaPathTag,
  sessionMediaOriginalsDir,
} from '@moonshot-ai/kimi-code-sdk';

import { getCacheDir } from '#/utils/paths';

import { MEDIA_FILE_REF_MIN_REMAINING_MS } from '../constant/media';
import type {
  ImageAttachment,
  ImageAttachmentStore,
  MediaAttachment,
  VideoAttachment,
} from './image-attachment-store';

const PLACEHOLDER_REGEX = /\[(image|video) #(\d+) (?:(\(\d+×\d+\))|([^\]]+))\]/g;

export interface ExtractionResult {
  parts: PromptPart[];
  hasMedia: boolean;
  imageAttachmentIds: number[];
  videoAttachmentIds: number[];
  imageSnapshots: ImageResendSnapshot[];
  mediaSnapshots?: readonly MediaAttachment[];
  mediaGeneration?: number;
}

export interface ImageResendSnapshot {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
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
  const mediaSnapshots: MediaAttachment[] = [];
  let cursor = 0;
  let hasMedia = false;

  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [literal, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const id = Number.parseInt(idStr, 10);
    const attachment = store.get(id);
    if (attachment === undefined) continue;
    if (attachment.kind !== kind) continue;
    mediaSnapshots.push(attachment);
    const before = text.slice(cursor, match.index);
    pushText(parts, before);
    if (attachment.kind === 'video') {
      parts.push(videoPartForAttachment(attachment));
      videoAttachmentIds.push(id);
    } else {
      const original = attachment.original;
      const originalBytes = original?.bytes ?? readOriginalImageBytes(original?.path);
      imageSnapshots.push({
        bytes: attachment.bytes,
        mime: attachment.mime,
        width: attachment.width,
        height: attachment.height,
        original:
          original === undefined || originalBytes === undefined
            ? undefined
            : {
                bytes: originalBytes,
                width: original.width,
                height: original.height,
                mime: original.mime,
              },
      });
      if (attachment.fileId !== undefined) {
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

  store.retainFileIds([...imageAttachmentIds, ...videoAttachmentIds]);
  const freshParts = refreshExpiringImageFileRefs(parts, imageAttachmentIds, store);
  return {
    parts: hasMedia ? freshParts : [],
    hasMedia,
    imageAttachmentIds,
    videoAttachmentIds,
    imageSnapshots,
    mediaSnapshots: mediaSnapshots.length > 0 ? mediaSnapshots : undefined,
    mediaGeneration: store.generation,
  };
}

export function pendingMediaIngestions(
  text: string,
  store: ImageAttachmentStore,
  timeoutMs: number,
): Promise<void> | undefined {
  const pendings: Promise<void>[] = [];
  PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_REGEX.exec(text)) !== null) {
    const [, kind, idStr] = match;
    if (kind !== 'image' && kind !== 'video') continue;
    if (idStr === undefined) continue;
    const attachment = store.get(Number.parseInt(idStr, 10));
    if (attachment?.kind === kind && attachment.pending !== undefined) {
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
      (expiresAt === undefined || expiresAt - now > MEDIA_FILE_REF_MIN_REMAINING_MS);
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

export function makeExtractionResendable(
  extraction: ExtractionResult,
  originalsDir?: string,
  originalReferences?: ReadonlyMap<number, string>,
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
      const caption: PromptPart = {
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
          originalPath: originalReferences === undefined
            ? persistOriginalImageSync(original.bytes, original.mime, originalsDir)
            : originalReferences.get(imageIndex - 1),
        }),
      };
      const previous = parts.at(-1);
      if (previous?.type === 'text' && previous.text.startsWith(CAPTION_OPENING)) {
        parts[parts.length - 1] = caption;
      } else {
        parts.push(caption);
      }
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
    imageAttachmentIds: [],
  };
}

export interface MediaTagRewriteResult {
  text: string;
  hasMedia: boolean;
  imageAttachmentIds: number[];
  videoAttachmentIds: number[];
  stagingPaths: string[];
  cachedVideos: VideoAttachment[];
}

export type MediaReferenceStyle = 'tag' | 'plain';

export function rewriteMediaPlaceholders(
  text: string,
  store: ImageAttachmentStore,
  style: MediaReferenceStyle = 'tag',
  mediaSnapshots?: readonly MediaAttachment[],
): MediaTagRewriteResult {
  const imageAttachmentIds: number[] = [];
  const videoAttachmentIds: number[] = [];
  const stagingPaths: string[] = [];
  const cachedVideos: VideoAttachment[] = [];
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
      const attachment = mediaSnapshots === undefined
        ? store.get(id)
        : mediaSnapshots.find((snapshot) => snapshot.id === id);
      if (attachment === undefined) continue;
      if (attachment.kind !== kind) continue;
      out += text.slice(cursor, match.index);
      if (attachment.kind === 'video') {
        const path = materializeVideoToCache(attachment, style === 'plain');
        stagingPaths.push(path);
        out +=
          style === 'plain'
            ? formatMediaReference('video', path)
            : buildMediaPathTag('video', path);
        cachedVideos.push(attachment);
        if (store.get(id) === attachment) videoAttachmentIds.push(id);
      } else {
        const path = materializeImageToCache(attachment);
        stagingPaths.push(path);
        out +=
          style === 'plain'
            ? formatMediaReference('image', path)
            : buildMediaPathTag('image', path);
        if (store.get(id) === attachment) imageAttachmentIds.push(id);
      }
      cursor = match.index + literal.length;
    }

    const hasMedia = stagingPaths.length > 0;
    store.retainFileIds(imageAttachmentIds);
    return {
      text: hasMedia ? out + text.slice(cursor) : text,
      hasMedia,
      imageAttachmentIds,
      videoAttachmentIds,
      stagingPaths,
      cachedVideos,
    };
  } catch (error) {
    cleanupStagingPaths(stagingPaths);
    throw error;
  }
}

export function omitExpiredVideoFileRefs(
  parts: readonly PromptPart[],
  cachedVideos: readonly VideoAttachment[],
): PromptPart[] {
  const expiredUrls = new Set(
    cachedVideos.flatMap((attachment) =>
      attachment.fileId !== undefined &&
      attachment.fileExpiresAt !== undefined &&
      attachment.fileExpiresAt - Date.now() <= MEDIA_FILE_REF_MIN_REMAINING_MS
        ? [buildDaemonFileUrl(attachment.fileId)]
        : [],
    ),
  );
  return parts.filter((part) => part.type !== 'video_url' || !expiredUrls.has(part.videoUrl.url));
}

function cleanupStagingPaths(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

function pushText(parts: PromptPart[], segment: string): void {
  if (segment.length === 0) return;
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

function videoPartForAttachment(att: VideoAttachment): PromptPart {
  const fileId = att.fileId;
  const expired =
    att.fileExpiresAt !== undefined &&
    att.fileExpiresAt - Date.now() <= MEDIA_FILE_REF_MIN_REMAINING_MS;
  if (fileId !== undefined && !expired) {
    return {
      type: 'video_url',
      videoUrl: { url: buildDaemonFileUrl(fileId) },
    };
  }
  if (att.pending !== undefined) {
    throw new Error(`Video "${att.label}" is still uploading; try again in a moment.`);
  }
  throw new Error(
    expired
      ? `Video "${att.label}" expired before it was sent; paste it again.`
      : `Video "${att.label}" could not be uploaded; paste it again.`,
  );
}

function materializeVideoToCache(att: VideoAttachment, escapeProofName = false): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
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

export function imageExtensionForMime(mime: string): string {
  return IMAGE_MIME_EXTENSION[mime.trim().toLowerCase()] ?? 'img';
}

function materializeImageToCache(att: ImageAttachment): string {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, `${randomUUID()}.${imageExtensionForMime(att.mime)}`);
  writeFileSync(target, att.bytes);
  return target;
}

const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

export function originalsDirForSession(session: Session | undefined): string | undefined {
  const sessionDir = session?.summary?.sessionDir;
  return sessionDir === undefined ? undefined : sessionMediaOriginalsDir(sessionDir);
}

function readOriginalImageBytes(path: string | undefined): Uint8Array | undefined {
  if (path === undefined) return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

export function resolveSessionOriginalCaptions(
  parts: readonly PromptPart[],
  imageAttachmentIds: readonly number[],
  store: ImageAttachmentStore,
  session: Session,
): PromptPart[] | Promise<PromptPart[]> {
  const images = parts.filter((part) => part.type === 'image_url');
  const originals = imageAttachmentIds.flatMap((id, index) => {
    const attachment = store.get(id);
    const part = images[index];
    if (attachment?.kind !== 'image' || attachment.original === undefined || part === undefined) return [];
    if (!imagePartMatchesAttachment(part, attachment)) return [];
    const original = attachment.original;
    const bytes = original.attachment?.sessionId === session.id
      ? undefined
      : original.bytes ?? readOriginalImageBytes(original.path);
    return [{ attachment, original, bytes }];
  });
  if (originals.length === 0) return [...parts];
  const dir = originalsDirForSession(session);
  const resolved = resolveOriginalCaptions(parts, imageAttachmentIds, store, dir, new Map());
  return Promise.all(originals.map(async ({ attachment, original, bytes }) => {
    if (original.attachment?.sessionId !== session.id) {
      if (bytes === undefined) throw new Error('The original pasted image is no longer available.');
      const reference = await session.attachFile(bytes, {
        name: `original.${imageExtensionForMime(original.mime)}`,
        mimeType: original.mime,
      });
      original.attachment = { sessionId: session.id, reference };
    }
    return [attachment.id, original.attachment.reference] as const;
  })).then((references) => resolveOriginalCaptions(resolved, imageAttachmentIds, store, dir, new Map(references)));
}

export async function makeSessionExtractionResendable(
  extraction: ExtractionResult,
  session: Session,
): Promise<ExtractionResult> {
  const references = new Map<number, string>();
  for (const [index, snapshot] of extraction.imageSnapshots.entries()) {
    if (snapshot.original === undefined) continue;
    references.set(index, await session.attachFile(snapshot.original.bytes, {
      name: `original.${imageExtensionForMime(snapshot.original.mime)}`,
      mimeType: snapshot.original.mime,
    }));
  }
  return makeExtractionResendable(extraction, originalsDirForSession(session), references);
}

export function resolveOriginalCaptions(
  parts: readonly PromptPart[],
  imageAttachmentIds: readonly number[],
  store: ImageAttachmentStore,
  originalsDir: string | undefined,
  originalReferences?: ReadonlyMap<number, string>,
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
    if (!imagePartMatchesAttachment(part, attachment)) {
      out.push(part);
      continue;
    }
    const original = attachment.original;
    if (original.path === undefined && original.bytes !== undefined) {
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
      originalPath: originalReferences === undefined ? original.path : originalReferences.get(attachment.id),
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
    if (existing === undefined || existing.size !== bytes.length) {
      writeFileSync(target, bytes);
    }
    sweepCacheSync(targetDir, maxTotalBytes);
    return statSync(target, { throwIfNoEntry: false }) === undefined ? null : target;
  } catch {
    return null;
  }
}

const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

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
    } catch {}
  }
}

function originalImageTempDir(): string {
  return join(tmpdir(), 'kimi-code-original-images');
}

function formatMediaReference(kind: 'image' | 'video', path: string): string {
  return `Attached ${kind} file: ${path} (open it with Read)`;
}
