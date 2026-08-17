import { join } from 'node:path';

import type { ContentPart } from '#/kosong/contract/message';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export const IMAGE_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.svgz': 'image/svg+xml',
});

export const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

export const AUDIO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
});

const IMAGE_EXT_BY_MIME = invertMimeBySuffix(IMAGE_MIME_BY_SUFFIX);
const VIDEO_EXT_BY_MIME = invertMimeBySuffix(VIDEO_MIME_BY_SUFFIX);
const AUDIO_EXT_BY_MIME = invertMimeBySuffix(AUDIO_MIME_BY_SUFFIX);

function invertMimeBySuffix(table: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [suffix, mime] of Object.entries(table)) {
    out[mime] ??= suffix;
  }
  return Object.freeze(out);
}

export function mediaExtensionForMime(mimeType: string): string | undefined {
  const semi = mimeType.indexOf(';');
  const base = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim().toLowerCase();
  return VIDEO_EXT_BY_MIME[base] ?? IMAGE_EXT_BY_MIME[base] ?? AUDIO_EXT_BY_MIME[base];
}

function mediaSuffix(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return '';
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (idx <= lastSep + 1) return '';
  return path.slice(idx).toLowerCase();
}

export function mediaKindForPath(path: string): 'image' | 'video' | 'audio' | undefined {
  const suffix = mediaSuffix(path);
  if (suffix in IMAGE_MIME_BY_SUFFIX) return 'image';
  if (suffix in VIDEO_MIME_BY_SUFFIX) return 'video';
  if (suffix in AUDIO_MIME_BY_SUFFIX) return 'audio';
  return undefined;
}

export function mediaKindForMime(mimeType: string): 'image' | 'video' | 'audio' | undefined {
  const semi = mimeType.indexOf(';');
  const base = (semi === -1 ? mimeType : mimeType.slice(0, semi)).trim().toLowerCase();
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('video/')) return 'video';
  if (base.startsWith('audio/')) return 'audio';
  return undefined;
}

export function mediaKindOfPart(part: ContentPart): 'image' | 'video' | 'audio' | undefined {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'video_url') return 'video';
  if (part.type === 'audio_url') return 'audio';
  return undefined;
}

const KIMI_FILE_SCHEME = 'kimi-file://';

export interface DaemonFileRef {
  readonly fileId: string;
}

export function isDaemonFileUrl(url: string): boolean {
  return url.startsWith(KIMI_FILE_SCHEME);
}

export function buildDaemonFileUrl(fileId: string): string {
  return `${KIMI_FILE_SCHEME}${fileId}`;
}

export function parseDaemonFileUrl(url: string): DaemonFileRef | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf('?');
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return fileId.length > 0 ? { fileId } : undefined;
}

export function daemonFileRefFromPart(
  part: ContentPart,
): { readonly kind: 'image' | 'video'; readonly ref: DaemonFileRef } | undefined {
  if (part.type === 'image_url') {
    const ref = parseDaemonFileUrl(part.imageUrl.url);
    return ref === undefined ? undefined : { kind: 'image', ref };
  }
  if (part.type === 'video_url') {
    const ref = parseDaemonFileUrl(part.videoUrl.url);
    return ref === undefined ? undefined : { kind: 'video', ref };
  }
  return undefined;
}

export const SESSION_MEDIA_DIR = 'media';

export function sessionMediaFilePath(sessionDir: string, fileId: string, ext: string): string {
  return join(sessionDir, SESSION_MEDIA_DIR, `${fileId}${ext}`);
}

const MEDIA_PATH_TAG_RE = /<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?/g;

export interface MediaPathTag {
  readonly kind: MediaKind;
  readonly path: string;
  readonly index: number;
  readonly text: string;
}

export function escapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function unescapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function buildMediaPathTag(kind: MediaKind, path: string): string {
  return `<${kind} path="${escapeMediaAttribute(path)}"></${kind}>`;
}

export function matchMediaPathTags(text: string): MediaPathTag[] {
  const tags: MediaPathTag[] = [];
  for (const match of text.matchAll(MEDIA_PATH_TAG_RE)) {
    tags.push({
      kind: match[1] as MediaKind,
      path: unescapeMediaAttribute(match[2]!),
      index: match.index,
      text: match[0],
    });
  }
  return tags;
}

export function matchSingleMediaPathTag(text: string): MediaPathTag | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const tags = matchMediaPathTags(trimmed);
  if (tags.length !== 1) return undefined;
  const tag = tags[0]!;
  return tag.index === 0 && tag.text.length === trimmed.length ? tag : undefined;
}
