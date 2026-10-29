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

export type MediaKind = 'image' | 'video';

export function mediaKindForMime(mimeType: string): MediaKind | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return undefined;
}

export function mediaMimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? VIDEO_MIME_BY_EXT[ext];
}

export function mediaKindForPath(path: string): MediaKind | undefined {
  const mimeType = mediaMimeForPath(path);
  return mimeType === undefined ? undefined : mediaKindForMime(mimeType);
}
