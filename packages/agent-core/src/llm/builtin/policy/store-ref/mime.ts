import type { MediaKind } from '#/llm/message';
import { IMAGE_MIME_BY_EXT, VIDEO_MIME_BY_EXT } from '#/llm/protocol/kit/media';

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);
const QUICKTIME_BRANDS = new Set(['qt  ']);

export function sniffMediaMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'AVI ') return 'video/x-msvideo';
  if (ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(bytes, 0, 3) === 'FLV') return 'video/x-flv';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    if (HEIF_BRANDS.has(brand)) return 'image/heif';
    if (QUICKTIME_BRANDS.has(brand)) return 'video/quicktime';
    if (brand.startsWith('3g')) return 'video/3gpp';
    return 'video/mp4';
  }
  return undefined;
}

export function mediaKindForMime(mimeType: string): MediaKind | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return undefined;
}

export function mediaMimeForPath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? VIDEO_MIME_BY_EXT[ext];
}
