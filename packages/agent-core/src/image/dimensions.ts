export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly transposed?: boolean;
}

function startsWith(buf: Buffer, signature: readonly number[] | Buffer): boolean {
  if (buf.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[i] !== signature[i]) return false;
  }
  return true;
}

function readExifOrientation(buf: Buffer, start: number, end: number): number | null {
  const boundedEnd = Math.min(end, buf.length);
  if (start + 6 > boundedEnd || buf.toString('latin1', start, start + 6) !== 'Exif\0\0') {
    return null;
  }
  const tiff = start + 6;
  if (tiff + 8 > boundedEnd) return null;
  const byteOrder = buf.toString('latin1', tiff, tiff + 2);
  const le = byteOrder === 'II';
  if (!le && byteOrder !== 'MM') return null;
  const u16 = (offset: number): number => (le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset));
  const u32 = (offset: number): number => (le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset));
  if (u16(tiff + 2) !== 42) return null;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > boundedEnd) return null;
  const entryCount = u16(ifd);
  for (let i = 0; i < entryCount; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > boundedEnd) return null;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function jpegDimensions(buf: Buffer): ImageDimensions | null {
  let orientation: number | null = null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return orientation !== null && orientation >= 5
        ? { width: height, height: width, transposed: true }
        : { width, height };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    if (marker === 0xe1 && orientation === null) {
      orientation = readExifOrientation(buf, offset + 4, offset + 2 + segmentLength);
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function webpDimensions(buf: Buffer): ImageDimensions | null {
  const fourCc = buf.subarray(12, 16).toString('latin1');
  if (fourCc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourCc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourCc === 'VP8X') {
    return {
      width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)),
      height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)),
    };
  }
  return null;
}

export function sniffImageDimensions(data: Uint8Array): ImageDimensions | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if ((startsWith(buf, Buffer.from('GIF87a')) || startsWith(buf, Buffer.from('GIF89a'))) && buf.length >= 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (startsWith(buf, Buffer.from('BM')) && buf.length >= 26) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (startsWith(buf, Buffer.from('RIFF')) && buf.length >= 30) return webpDimensions(buf);
  if (startsWith(buf, [0xff, 0xd8])) return jpegDimensions(buf);
  return null;
}
