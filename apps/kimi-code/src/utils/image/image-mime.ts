export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageMeta {
  mime: SupportedImageMime;
  width: number;
  height: number;
}

export function parseImageMeta(bytes: Uint8Array): ImageMeta | null {
  if (isPng(bytes)) return parsePng(bytes);
  if (isJpeg(bytes)) return parseJpeg(bytes);
  if (isGif(bytes)) return parseGif(bytes);
  if (isWebp(bytes)) return parseWebp(bytes);
  return null;
}

function isPng(b: Uint8Array): boolean {
  return (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function parsePng(b: Uint8Array): ImageMeta | null {
  if (b.length < 24) return null;
  const width = readUInt32BE(b, 16);
  const height = readUInt32BE(b, 20);
  if (width <= 0 || height <= 0) return null;
  return { mime: 'image/png', width, height };
}

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function parseJpeg(b: Uint8Array): ImageMeta | null {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (i + 1 >= b.length) return null;
    const segLen = readUInt16BE(b, i);
    if (isSofMarker(marker)) {
      if (i + 7 >= b.length) return null;
      const height = readUInt16BE(b, i + 3);
      const width = readUInt16BE(b, i + 5);
      if (width <= 0 || height <= 0) return null;
      return { mime: 'image/jpeg', width, height };
    }
    i += segLen;
  }
  return null;
}

function isSofMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isGif(b: Uint8Array): boolean {
  return (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  );
}

function parseGif(b: Uint8Array): ImageMeta | null {
  if (b.length < 10) return null;
  const width = readUInt16LE(b, 6);
  const height = readUInt16LE(b, 8);
  if (width <= 0 || height <= 0) return null;
  return { mime: 'image/gif', width, height };
}

function isWebp(b: Uint8Array): boolean {
  return (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  );
}

function parseWebp(b: Uint8Array): ImageMeta | null {
  if (b.length < 30) return null;
  const chunk = String.fromCodePoint(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === 'VP8 ') {
    const widthRaw = readUInt16LE(b, 26);
    const heightRaw = readUInt16LE(b, 28);
    const width = widthRaw & 0x3fff;
    const height = heightRaw & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const b1 = b[21]!;
    const b2 = b[22]!;
    const b3 = b[23]!;
    const b4 = b[24]!;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height };
  }
  if (chunk === 'VP8X') {
    const width = 1 + readUInt24LE(b, 24);
    const height = 1 + readUInt24LE(b, 27);
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height };
  }
  return null;
}

function readUInt16BE(b: Uint8Array, off: number): number {
  return (b[off]! << 8) | b[off + 1]!;
}
function readUInt16LE(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function readUInt24LE(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16);
}
function readUInt32BE(b: Uint8Array, off: number): number {
  return Math.trunc(
    b[off]! * 0x100_0000 + (b[off + 1]! << 16) + (b[off + 2]! << 8) + b[off + 3]!,
  );
}
