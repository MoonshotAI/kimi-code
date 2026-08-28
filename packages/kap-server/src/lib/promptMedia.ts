import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
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
  MAX_IMAGE_DECODE_BYTES,
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
  type PromptFileAttachment,
} from '@moonshot-ai/agent-core-v2';
import { sniffMediaFromMagic } from '@moonshot-ai/agent-core-v2/agent/media/file-type';
import {
  IMAGE_MIME_BY_SUFFIX,
  VIDEO_MIME_BY_SUFFIX,
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';
import { isSensitiveFile } from '@moonshot-ai/agent-core-v2/tool/path-access';

import type { PromptSubmission } from '../protocol/rest-prompt';

type WireContent = PromptSubmission['content'];

export async function assertPromptFileRefs(content: WireContent, store: IFileService): Promise<void> {
  for (const part of content) {
    if (part.type === 'file') {
      if (part.file_id !== undefined) await store.get(part.file_id);
    } else if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'file') {
      const file = await store.get(part.source.file_id);
      assertMediaFile(file, part.type);
    }
  }
}

export async function assertPromptPathRefs(content: WireContent): Promise<void> {
  for (const part of content) {
    const path = promptPartPath(part);
    if (path === undefined) continue;
    if (!isAbsolute(path)) {
      throw new Error2('validation.failed', `attachment path must be absolute: ${path}`);
    }
    const { resolvedPath } = await statAttachmentFile(path);
    if (isSensitiveFile(resolvedPath)) {
      throw new Error2('validation.failed', `attachment path is a sensitive file: ${path}`);
    }
  }
}

export function contentHasPathRefs(content: WireContent): boolean {
  return content.some((part) => promptPartPath(part) !== undefined);
}

function promptPartPath(part: WireContent[number]): string | undefined {
  if (part.type === 'file') return part.path;
  if ((part.type === 'image' || part.type === 'video') && part.source.kind === 'path') {
    return part.source.path;
  }
  return undefined;
}

async function statAttachmentFile(sourcePath: string): Promise<{ resolvedPath: string; info: Stats }> {
  const resolvedPath = await realpath(sourcePath).catch(() => undefined);
  if (resolvedPath === undefined) throw fileNotFoundError(sourcePath);
  const info = await stat(resolvedPath).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw fileNotFoundError(sourcePath);
  return { resolvedPath, info };
}

function isFsError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

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
    else if (part.type === 'image' && part.source.kind === 'session_media') parts.push({ type: 'image_url', imageUrl: { url: buildDaemonFileUrl(part.source.file_id), id: part.source.file_id } });
    else if (part.type === 'video' && part.source.kind === 'url') parts.push({ type: 'video_url', videoUrl: { url: part.source.url, id: part.source.id } });
    else if (part.type === 'video' && part.source.kind === 'base64') parts.push({ type: 'video_url', videoUrl: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
    else if (part.type === 'video' && part.source.kind === 'session_media') parts.push({ type: 'video_url', videoUrl: { url: buildDaemonFileUrl(part.source.file_id), id: part.source.file_id } });
  }
  return parts;
}

export interface ResolvePromptMediaOptions {
  readonly resolveOriginalsDir?: () => Promise<string | undefined>;
  readonly resolveAttachmentsDir?: () => Promise<string | undefined>;
  readonly telemetry?: ITelemetryService;
}

export interface PromptMediaPreparation {
  readonly content: WireContent;
  readonly attachments: readonly PromptFileAttachment[];
  readonly discard: () => Promise<void>;
}

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
  const attachments: PromptFileAttachment[] = [];
  const content: WireContent = [];
  try {
    for (const part of input) {
      if (part.type === 'image' && part.source.kind === 'base64') {
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
          if (persisted !== null) {
            attachments.push({ name, mediaType: effectiveMime, size: bytes.length, path: persisted });
          }
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

      if (part.type === 'file') {
        if (part.path !== undefined) {
          const sourcePath = part.path;
          const { info } = await statAttachmentFile(sourcePath);
          const name = part.name ?? basename(sourcePath);
          const mediaType = part.media_type ?? 'application/octet-stream';
          content.push({
            type: 'text',
            text: buildAttachedFileNotice(name, mediaType, info.size, sourcePath),
          });
          attachments.push({ name, mediaType, size: info.size, path: sourcePath });
          changed = true;
          continue;
        }
        if (part.file_id === undefined) {
          throw new Error2('validation.failed', 'file part requires file_id or path');
        }
        const file = await store.get(part.file_id);
        const attachedPath = await materializeAttachmentToDir(file, await resolveAttachmentsDir());
        content.push({
          type: 'text',
          text: buildAttachedFileNotice(file.meta.name, file.meta.media_type, file.meta.size, attachedPath),
        });
        attachments.push({
          name: file.meta.name,
          mediaType: file.meta.media_type,
          size: file.meta.size,
          path: attachedPath,
        });
        changed = true;
        continue;
      }

      if (part.type === 'image' && part.source.kind === 'path') {
        const sourcePath = part.source.path;
        const { resolvedPath, info } = await statAttachmentFile(sourcePath);
        if (info.size > MAX_IMAGE_DECODE_BYTES) {
          throw new Error2(
            'validation.failed',
            `${sourcePath} is ${info.size} bytes, over the ${MAX_IMAGE_DECODE_BYTES}-byte image decode limit — attach it as a file instead`,
          );
        }
        const data = await readFile(resolvedPath).catch((error: unknown) => {
          if (isFsError(error)) throw fileNotFoundError(sourcePath);
          throw error;
        });
        const name = basename(sourcePath);
        const declared = pathMediaMime(sourcePath, data, 'image');
        if (!declared.startsWith('image/')) {
          throw new Error2('validation.failed', `${sourcePath} is ${declared}, not an image`);
        }
        let mediaType = resolveEffectiveImageMime(declared, data);
        if (!isModelAcceptedImageMime(mediaType)) {
          content.push({
            type: 'text',
            text: buildAttachedFileNotice(name, mediaType, data.length, sourcePath),
          });
          attachments.push({ name, mediaType, size: data.length, path: sourcePath });
          changed = true;
          continue;
        }
        mediaType = normalizeImageMime(mediaType);
        const compressed = await compressImageForModel(data, mediaType, {
          telemetry: telemetryFor('prompt_file'),
        });
        if (compressed.changed) {
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
              originalPath: sourcePath,
            }),
          });
        }
        const saved = await store.save(
          Readable.from(compressed.changed ? Buffer.from(compressed.data) : data),
          compressed.changed ? compressedUploadName(name, compressed.mimeType) : name,
          { mimeType: compressed.changed ? compressed.mimeType : mediaType },
        );
        ownedFileIds.add(saved.id);
        content.push({
          type: 'image',
          source: { kind: 'url', url: buildDaemonFileUrl(saved.id) },
        });
        changed = true;
        continue;
      }

      if (part.type === 'video' && part.source.kind === 'path') {
        const sourcePath = part.source.path;
        const { resolvedPath } = await statAttachmentFile(sourcePath);
        const mediaType = pathMediaMime(sourcePath, undefined, 'video');
        if (!mediaType.startsWith('video/')) {
          throw new Error2('validation.failed', `${sourcePath} is ${mediaType}, not a video`);
        }
        const saved = await store
          .save(createReadStream(resolvedPath), basename(sourcePath), { mimeType: mediaType })
          .catch((error: unknown) => {
            if (isFsError(error)) throw fileNotFoundError(sourcePath);
            throw error;
          });
        ownedFileIds.add(saved.id);
        content.push({
          type: 'video',
          source: { kind: 'url', url: buildDaemonFileUrl(saved.id) },
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
          if (persisted !== null) {
            attachments.push({
              name: file.meta.name,
              mediaType,
              size: file.meta.size,
              path: persisted,
            });
          }
          changed = true;
          continue;
        }
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
        let finalFile = file;
        if (compressed.changed) {
          const saved = await store.save(
            Readable.from(Buffer.from(compressed.data)),
            compressedUploadName(file.meta.name, compressed.mimeType),
            { mimeType: compressed.mimeType },
          );
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

      content.push({
        type: 'video',
        source: { kind: 'url', url: buildDaemonFileUrl(file.meta.id) },
      });
      changed = true;
    }
    return { content: changed ? content : input, attachments, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

function compressedUploadName(originalName: string, mimeType: string): string {
  const base = originalName.replace(/\.[^./\\]*$/, '');
  return `${base.length > 0 ? base : 'image'}.${imageExtensionForMime(mimeType)}`;
}

const ATTACHMENT_NAME_MAX = 100;

function sanitizeAttachmentName(name: string): string {
  const cleaned = name
    .replaceAll(/[\\/]/g, '_')
    .replaceAll(/[\u0000-\u001F\u007F]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX);
  return cleaned.length > 0 ? cleaned : 'attachment';
}

async function materializeAttachmentToDir(file: GetResult, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${file.meta.id}-${sanitizeAttachmentName(file.meta.name)}`);
  const info = await stat(target).catch(() => undefined);
  if (info?.size === file.meta.size) return target;

  await pipeline(file.stream(), createWriteStream(target));
  return target;
}

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

function imageExtensionForMime(mediaType: string): string {
  const subtype = mediaType.split('/')[1]?.toLowerCase().split('+')[0] ?? '';
  const ext = subtype.replaceAll(/[^a-z0-9-]/g, '');
  return ext.length > 0 ? ext : 'img';
}

function pathMediaMime(
  sourcePath: string,
  data: Uint8Array | undefined,
  kind: 'image' | 'video',
): string {
  const suffix = extname(sourcePath).toLowerCase();
  if (kind === 'image') {
    if (suffix === '.svg') return 'image/svg+xml';
    const declared = IMAGE_MIME_BY_SUFFIX[suffix];
    if (declared !== undefined) return declared;
  } else {
    const declared = VIDEO_MIME_BY_SUFFIX[suffix];
    if (declared !== undefined) return declared;
  }
  const sniffed = data === undefined ? null : sniffMediaFromMagic(data);
  return sniffed?.mimeType ?? 'application/octet-stream';
}

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
