/**
 * Dependency-free solid-color PNG builder for prompt-image compression tests.
 *
 * The `jimp`-based fixtures used by the engine's own media tests would drag a
 * dev dependency into this package for a handful of bytes; a solid RGB PNG is
 * a fixed header plus a zlib stream of repeated scanlines, so Node's built-in
 * `zlib` covers it. The output is a fully valid PNG (real CRCs), accepted by
 * the engine's decoder.
 */

import { deflateSync } from 'node:zlib';

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  // Unsigned-32 conversion without `>>> 0` (lint: prefer-math-trunc).
  return ~crc < 0 ? ~crc + 0x1_0000_0000 : ~crc;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Build a solid black 8-bit RGB PNG of the given dimensions. */
export function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const row = Buffer.alloc(1 + width * 3); // filter byte 0 + black pixels
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Base64 form of {@link solidPng}, ready for an ACP image block. */
export function solidPngBase64(width: number, height: number): string {
  return solidPng(width, height).toString('base64');
}
