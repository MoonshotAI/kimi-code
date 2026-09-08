import { describe, it, expect } from 'vitest';

import { isHeicImage, parseImageMeta } from '#/utils/image/image-mime';

function png(width: number, height: number): Uint8Array {
  // 8-byte PNG signature + IHDR length (4) + 'IHDR' + width (4 BE) + height (4 BE) + ...
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // length = 13 (IHDR body)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  // width
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  // height
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI + SOF0 marker with the minimal segment body.
  // Layout: FFD8 FFC0 <len16 BE> <precision 08> <height BE> <width BE> <components 03>
  const body = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x11, // segment length (17 bytes including itself)
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
    // 3 component spec blocks (3 bytes each) — not parsed but required for realism
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
  return body;
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  // "GIF89a"
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

describe('parseImageMeta', () => {
  it('recognises PNG with correct dimensions', () => {
    const meta = parseImageMeta(png(640, 480));
    expect(meta).toEqual({ mime: 'image/png', width: 640, height: 480 });
  });

  it('recognises JPEG with correct dimensions', () => {
    const meta = parseImageMeta(jpeg(1280, 720));
    expect(meta).toEqual({ mime: 'image/jpeg', width: 1280, height: 720 });
  });

  it('recognises GIF (89a)', () => {
    const meta = parseImageMeta(gif(100, 200));
    expect(meta).toEqual({ mime: 'image/gif', width: 100, height: 200 });
  });

  it('recognises GIF (87a)', () => {
    const bytes = gif(50, 75);
    bytes[4] = 0x37; // '7'
    const meta = parseImageMeta(bytes);
    expect(meta).toEqual({ mime: 'image/gif', width: 50, height: 75 });
  });

  it('returns null for non-image bytes', () => {
    expect(parseImageMeta(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parseImageMeta(new Uint8Array([]))).toBeNull();
  });

  it('returns null for truncated PNG', () => {
    const full = png(10, 10);
    expect(parseImageMeta(full.slice(0, 20))).toBeNull();
  });
});

function ftyp(brand: string): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x00, 0x00, 0x00, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set(Array.from(brand.padEnd(4, ' '), (char) => char.codePointAt(0)!), 8);
  return bytes;
}

describe('isHeicImage', () => {
  it.each(['heic', 'heix', 'hevc', 'hevx', 'heif', 'mif1', 'msf1'])(
    'recognizes the %s ftyp brand',
    (brand) => {
      expect(isHeicImage(ftyp(brand))).toBe(true);
    },
  );

  it('rejects other ftyp brands and non-ISO-BMFF images', () => {
    expect(isHeicImage(ftyp('avif'))).toBe(false);
    expect(isHeicImage(ftyp('isom'))).toBe(false);
    expect(isHeicImage(png(1, 1))).toBe(false);
    expect(isHeicImage(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74]))).toBe(false);
  });

  it('is not a format parseImageMeta accepts', () => {
    expect(parseImageMeta(ftyp('heic'))).toBeNull();
  });
});
