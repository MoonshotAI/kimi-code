import { crc32, deflateSync } from 'node:zlib';

export const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export function solidPng(width: number, height: number, rgba: readonly [number, number, number, number] = [255, 0, 0, 255]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4).fill(Buffer.from(rgba))]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function mp4Header(): Buffer {
  const brands = ['isom', 'iso2', 'mp41'];
  const box = Buffer.alloc(16 + brands.length * 4);
  box.writeUInt32BE(box.length, 0);
  box.write('ftyp', 4, 'ascii');
  box.write('isom', 8, 'ascii');
  box.writeUInt32BE(0x200, 12);
  brands.forEach((brand, index) => box.write(brand, 16 + index * 4, 'ascii'));
  return box;
}

export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export const BROKEN_DATA_URLS = {
  badBase64: 'data:image/png;base64,@@not-base64@@',
  missingComma: 'data:image/png;base64',
  textAsImage: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`,
  unknownMediaType: `data:application/x-testkit;base64,${ONE_PIXEL_PNG_BASE64}`,
} as const;

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}
