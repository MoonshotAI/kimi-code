import type { MediaKind } from '#/llm/message';
import type { LlmFileInput } from '#/llm/request';

import type { MediaKindSupport, MediaSupport } from '../rules/media';

export const BASELINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
};

export function uploadFilename(file: LlmFileInput): string {
  if (file.filename !== undefined) return file.filename;
  const ext = Object.entries({ ...IMAGE_MIME_BY_EXT, ...VIDEO_MIME_BY_EXT }).find(
    ([, mime]) => mime === file.mimeType,
  )?.[0];
  return `upload.${ext ?? 'bin'}`;
}

export function textOnlyToolResults(support: MediaSupport): MediaSupport {
  const kinds: Partial<Record<MediaKind, MediaKindSupport>> = {};
  for (const [kind, spec] of Object.entries(support.kinds) as [MediaKind, MediaKindSupport][]) {
    kinds[kind] = { ...spec, inToolResult: 'unsupported' };
  }
  return { kinds };
}
