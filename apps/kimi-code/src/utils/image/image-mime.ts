/**
 * Detect image MIME type + dimensions from raw bytes.
 *
 * Uses magic-byte sniffing for MIME and minimal format-specific parsing
 * for dimensions. Only formats that the kimi-core multimodal pipeline
 * accepts are supported: PNG / JPEG / GIF / WebP.
 *
 * Unsupported or truncated inputs return `null` so the caller can
 * decline the paste cleanly.
 */

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

// ── HEIC / HEIF ─────────────────────────────────────────────────────

const HEIC_FTYP_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'msf1']);

/**
 * Sniff an ISO-BMFF `ftyp` box whose major brand is one of the HEIF
 * family. HEIC is not a format the model pipeline accepts, so this is
 * only used to decide whether a pasted file should be converted first
 * (macOS `sips`) rather than declined outright.
 */
export function isHeicImage(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
  const brand = String.fromCodePoint(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
    .trim()
    .toLowerCase();
  return HEIC_FTYP_BRANDS.has(brand);
}

// ── PNG ─────────────────────────────────────────────────────────────

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
  // IHDR chunk immediately follows the 8-byte signature: length (4) +
  // "IHDR" (4) + width (4 BE) + height (4 BE) + ...
  if (b.length < 24) return null;
  const width = readUInt32BE(b, 16);
  const height = readUInt32BE(b, 20);
  if (width <= 0 || height <= 0) return null;
  return { mime: 'image/png', width, height };
}

// ── JPEG ────────────────────────────────────────────────────────────

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function parseJpeg(b: Uint8Array): ImageMeta | null {
  // Scan for a Start-Of-Frame marker (SOF0..SOF3, SOF5..SOF7, SOF9..SOF11,
  // SOF13..SOF15). After the marker + 2-byte segment length come:
  //   precision (1), height (2 BE), width (2 BE), components (1).
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    // Skip fill bytes (0xFF padding before a marker).
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const marker = b[i]!;
    i += 1;
    if (marker === 0xd8 || marker === 0xd9) continue; // SOI / EOI — no length
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
  // Exclude DHT (0xC4), JPG (0xC8), DAC (0xCC) — these reuse the SOF
  // number range but are not frame headers.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// ── GIF ─────────────────────────────────────────────────────────────

function isGif(b: Uint8Array): boolean {
  return (
    b.length >= 6 &&
    b[0] === 0x47 && // G
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x38 && // 8
    (b[4] === 0x37 || b[4] === 0x39) && // 7 or 9
    b[5] === 0x61 // a
  );
}

function parseGif(b: Uint8Array): ImageMeta | null {
  // Logical screen width/height are at offsets 6-9, little-endian.
  if (b.length < 10) return null;
  const width = readUInt16LE(b, 6);
  const height = readUInt16LE(b, 8);
  if (width <= 0 || height <= 0) return null;
  return { mime: 'image/gif', width, height };
}

// ── WebP ────────────────────────────────────────────────────────────

function isWebp(b: Uint8Array): boolean {
  return (
    b.length >= 12 &&
    b[0] === 0x52 && // R
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x46 && // F
    b[8] === 0x57 && // W
    b[9] === 0x45 && // E
    b[10] === 0x42 && // B
    b[11] === 0x50 // P
  );
}

function parseWebp(b: Uint8Array): ImageMeta | null {
  // WebP has three sub-formats: VP8 (simple), VP8L (lossless), VP8X
  // (extended). Offset 12 is the 4-byte chunk identifier.
  if (b.length < 30) return null;
  const chunk = String.fromCodePoint(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === 'VP8 ') {
    // Frame data starts at offset 20 + 3-byte start code; dimensions at
    // offsets 26-29 (little-endian, 14-bit values with 2 top bits masked).
    const widthRaw = readUInt16LE(b, 26);
    const heightRaw = readUInt16LE(b, 28);
    const width = widthRaw & 0x3fff;
    const height = heightRaw & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height };
  }
  if (chunk === 'VP8L') {
    // VP8L packs width-1 (14 bits) and height-1 (14 bits) across bytes 21-24
    // starting from the signature byte at offset 20 (0x2F).
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
    // Canvas width-1 at offsets 24-26, height-1 at 27-29 (24-bit LE).
    const width = 1 + readUInt24LE(b, 24);
    const height = 1 + readUInt24LE(b, 27);
    if (width <= 0 || height <= 0) return null;
    return { mime: 'image/webp', width, height };
  }
  return null;
}

// ── byte helpers ────────────────────────────────────────────────────

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
