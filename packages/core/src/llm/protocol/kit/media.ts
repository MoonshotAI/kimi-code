import type { MediaPart } from '#/llm/message';
import type { LlmFileInput } from '#/llm/request';

export const BASELINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const BASELINE_INLINE_IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

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

export interface ProviderImagePolicy {
  readonly acceptedMimes: ReadonlySet<string>;
  readonly inlineByteBudget: number;
}

export const DEFAULT_INLINE_IMAGE_BYTE_BUDGET = BASELINE_INLINE_IMAGE_BYTE_BUDGET;

const BASELINE_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: BASELINE_IMAGE_MIMES,
  inlineByteBudget: DEFAULT_INLINE_IMAGE_BYTE_BUDGET,
};

const KIMI_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set([...BASELINE_IMAGE_MIMES, 'image/bmp', 'image/heic', 'image/heif']),
  inlineByteBudget: 5 * 1024 * 1024,
};

export function providerImagePolicy(provider?: string): ProviderImagePolicy {
  return provider === 'kimi' ? KIMI_IMAGE_POLICY : BASELINE_IMAGE_POLICY;
}

export function mediaUrlOf(part: MediaPart): string {
  switch (part.type) {
    case 'image_url':
      return part.imageUrl.url;
    case 'audio_url':
      return part.audioUrl.url;
    case 'video_url':
      return part.videoUrl.url;
  }
}

export function mediaFileIdOf(part: MediaPart): string | undefined {
  switch (part.type) {
    case 'image_url':
      return part.imageUrl.id;
    case 'audio_url':
      return part.audioUrl.id;
    case 'video_url':
      return part.videoUrl.id;
  }
}

export interface InlineMedia {
  readonly mimeType: string;
  readonly data: string;
}

export function inlineMediaOf(part: MediaPart): InlineMedia | undefined {
  const match = /^data:([^;,]+(?:;[^;,]*)*);base64,([\s\S]*)$/i.exec(mediaUrlOf(part));
  return match === null ? undefined : { mimeType: match[1]!, data: match[2]! };
}

export function uploadFilename(file: LlmFileInput): string {
  if (file.filename !== undefined) return file.filename;
  const ext = Object.entries({ ...IMAGE_MIME_BY_EXT, ...VIDEO_MIME_BY_EXT }).find(
    ([, mime]) => mime === file.mimeType,
  )?.[0];
  return `upload.${ext ?? 'bin'}`;
}
