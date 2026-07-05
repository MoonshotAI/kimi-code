/**
 * image-compress — downsample/re-encode oversized images for the model.
 *
 * Tests pin:
 *   - fast path: an image within both budgets passes through untouched
 *     (same byte reference, no re-encode)
 *   - dimension cap: an oversized image is scaled so its longest edge is
 *     exactly MAX_IMAGE_EDGE_PX, preserving aspect ratio
 *   - byte budget: an over-budget image walks the JPEG quality ladder and
 *     comes back as JPEG, strictly smaller than the input
 *   - alpha: a translucent PNG stays PNG when the budget allows, and only
 *     drops to JPEG as a last resort to meet a tiny budget
 *   - fallback: corrupt/empty bytes and non-recodable formats (GIF/WebP)
 *     return the original unchanged — never throws
 *   - invariant: `changed` implies the result is strictly smaller
 *   - base64 wrapper round-trips
 *   - performance: the fast path is codec-free; a large image compresses
 *     within a generous time bound
 *   - metadata: results always carry the original pixel dimensions
 *   - crop: cropImageForModel cuts a region at native resolution, clamps
 *     overflow, refuses out-of-bounds/undecodable input explicitly, and
 *     honors skipResize with a hard byte-budget failure
 *   - caption: buildImageCompressionCaption renders a consistent
 *     `<system>` note (dims, sizes, readback path)
 *   - annotate: compressImageContentParts can insert that caption next to
 *     each compressed image and persist the original via a callback
 */

import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-unresolved
import {
  buildImageCompressionCaption,
  compressBase64ForModel,
  compressImageContentParts,
  compressImageForModel,
  cropImageForModel,
  extractImageCompressionCaptions,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '../../src/tools/support/image-compress';
// eslint-disable-next-line import/no-unresolved
import { sniffImageDimensions } from '../../src/tools/support/file-type';

// ── fixtures ─────────────────────────────────────────────────────────

async function solidPng(width: number, height: number, color = 0x3366ccff): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color });
  return new Uint8Array(await image.getBuffer('image/png'));
}

async function solidJpeg(width: number, height: number, color = 0x3366ccff): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color });
  return new Uint8Array(await image.getBuffer('image/jpeg', { quality: 90 }));
}

async function translucentPng(width: number, height: number): Promise<Uint8Array> {
  // Alpha 0x80 on every pixel → hasAlpha() is true.
  const image = new Jimp({ width, height, color: 0x33_66_cc_80 });
  return new Uint8Array(await image.getBuffer('image/png'));
}

/** High-entropy image whose PNG barely compresses — used to force the ladder. */
async function noisePng(width: number, height: number, alpha = false): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  const data = image.bitmap.data;
  for (let i = 0; i < data.length; i += 4) {
    // Deterministic pseudo-random bytes (no Math.random for stable fixtures).
    // Distinct multipliers per channel keep entropy high so PNG barely shrinks.
    data[i] = (i * 2_654_435_761) & 0xff;
    data[i + 1] = (i * 40_503) & 0xff;
    data[i + 2] = (i * 12_289) & 0xff;
    data[i + 3] = alpha ? (i * 7 + 17) & 0xff : 0xff;
  }
  return new Uint8Array(await image.getBuffer('image/png'));
}

async function decodeAlpha(bytes: Uint8Array): Promise<boolean> {
  const image = await Jimp.fromBuffer(Buffer.from(bytes));
  return image.hasAlpha();
}

// ── fast path ────────────────────────────────────────────────────────

describe('compressImageForModel — fast path', () => {
  it('passes a within-budget image through untouched (same reference)', async () => {
    const png = await solidPng(64, 64);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(png); // identity: no copy, no re-encode
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(64);
    expect(result.height).toBe(64);
  });

  it('treats image/jpg as image/jpeg', async () => {
    const jpeg = await solidJpeg(32, 32);
    const result = await compressImageForModel(jpeg, 'image/jpg');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(jpeg);
  });
});

// ── dimension cap ────────────────────────────────────────────────────

describe('compressImageForModel — dimension cap', () => {
  it('scales the longest edge down to MAX_IMAGE_EDGE_PX, preserving aspect', async () => {
    const png = await solidPng(3000, 1500);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
    // 3000x1500 → 2000x1000 (aspect 2:1 preserved).
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
    const dims = sniffImageDimensions(result.data);
    expect(dims).toEqual({ width: 2000, height: 1000 });
  });

  it('respects a custom maxEdge', async () => {
    const png = await solidPng(1600, 800);
    const result = await compressImageForModel(png, 'image/png', { maxEdge: 800 });
    expect(result.changed).toBe(true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it('keeps a downscaled opaque PNG lossless (no needless JPEG conversion)', async () => {
    // A screenshot-like opaque PNG that only needs downscaling must stay PNG so
    // sharp text is not degraded by JPEG artifacts.
    const png = await solidPng(3000, 1500);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
  });
});

// ── byte budget ──────────────────────────────────────────────────────

describe('compressImageForModel — byte budget', () => {
  it('walks the JPEG ladder for an over-budget non-alpha image', async () => {
    const png = await noisePng(900, 900);
    const result = await compressImageForModel(png, 'image/png', { byteBudget: 8 * 1024 });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.finalByteLength).toBeLessThan(result.originalByteLength);
  });

  it('keeps a translucent PNG as PNG when the budget allows', async () => {
    const png = await translucentPng(2600, 2600);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
    expect(await decodeAlpha(result.data)).toBe(true);
  });

  it('drops alpha to JPEG only as a last resort under a tiny budget', async () => {
    const png = await noisePng(800, 800, /* alpha */ true);
    const result = await compressImageForModel(png, 'image/png', { byteBudget: 4 * 1024 });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.finalByteLength).toBeLessThan(result.originalByteLength);
  });
});

// ── fallback / robustness ────────────────────────────────────────────

describe('compressImageForModel — fallback', () => {
  it('returns the original on corrupt bytes (never throws)', async () => {
    // Valid PNG signature followed by garbage — decode will fail.
    const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    const result = await compressImageForModel(corrupt, 'image/png');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(corrupt);
  });

  it('passes empty buffers through', async () => {
    const empty = new Uint8Array(0);
    const result = await compressImageForModel(empty, 'image/png');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(empty);
  });

  it('passes GIF through (preserves animation)', async () => {
    // Minimal GIF89a header — enough for the MIME guard to skip it.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const result = await compressImageForModel(gif, 'image/gif');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(gif);
  });

  it('passes WebP through (no codec in the default build)', async () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]);
    const result = await compressImageForModel(webp, 'image/webp');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(webp);
  });

  it('skips compression for absurd pixel counts without decoding (bomb guard)', async () => {
    // A PNG header advertising 30000×30000 (900 MP) with no pixel data. The
    // dimension sniff reads the IHDR; the guard must pass through before Jimp
    // is ever invoked, so this completes instantly with no multi-GB bitmap.
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8); // IHDR chunk length
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(30000, 16);
    header.writeUInt32BE(30000, 20);
    const bomb = new Uint8Array(header);

    const result = await compressImageForModel(bomb, 'image/png');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(bomb); // identity → Jimp was never called
  });

  it('skips compression for payloads over the byte cap without decoding', async () => {
    // Over the edge (so not the fast path), but capped by maxDecodeBytes.
    const png = await solidPng(3000, 100);
    const result = await compressImageForModel(png, 'image/png', { maxDecodeBytes: 64 });
    expect(result.changed).toBe(false);
    expect(result.data).toBe(png); // passthrough → Jimp was never called
  });
});

// ── invariants ───────────────────────────────────────────────────────

describe('compressImageForModel — invariants', () => {
  it('changed always yields a within-cap, decodable payload', async () => {
    const cases: Uint8Array[] = [
      await solidPng(3000, 1500),
      await noisePng(900, 900),
      await translucentPng(2600, 2600),
    ];
    for (const bytes of cases) {
      const result = await compressImageForModel(bytes, 'image/png');
      expect(result.finalByteLength).toBe(result.data.length);
      if (result.changed) {
        // A change is only kept when it helped: fewer bytes or fewer pixels.
        const original = sniffImageDimensions(bytes)!;
        const shrankBytes = result.finalByteLength < result.originalByteLength;
        const shrankPixels = result.width * result.height < original.width * original.height;
        expect(shrankBytes || shrankPixels).toBe(true);
        // Dimensions never exceed the cap after a change.
        expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
        // The result must decode.
        expect(sniffImageDimensions(result.data)).not.toBeNull();
      }
    }
  });
});

// ── base64 wrapper ───────────────────────────────────────────────────

describe('compressBase64ForModel', () => {
  it('round-trips an over-sized image', async () => {
    const png = await noisePng(700, 700);
    const base64 = Buffer.from(png).toString('base64');
    const result = await compressBase64ForModel(base64, 'image/png', { byteBudget: 8 * 1024 });
    expect(result.changed).toBe(true);
    expect(result.finalByteLength).toBeLessThan(result.originalByteLength);
    // The re-encoded base64 still decodes to a valid image.
    const dims = sniffImageDimensions(Buffer.from(result.base64, 'base64'));
    expect(dims).not.toBeNull();
  });

  it('returns the original base64 unchanged on the fast path', async () => {
    const png = await solidPng(64, 64);
    const base64 = Buffer.from(png).toString('base64');
    const result = await compressBase64ForModel(base64, 'image/png');
    expect(result.changed).toBe(false);
    expect(result.base64).toBe(base64);
  });

  it('skips a base64 payload over the byte cap without decoding', async () => {
    const png = await solidPng(3000, 100); // over edge, would otherwise compress
    const base64 = Buffer.from(png).toString('base64');
    const result = await compressBase64ForModel(base64, 'image/png', { maxDecodeBytes: 64 });
    expect(result.changed).toBe(false);
    expect(result.base64).toBe(base64); // unchanged → not decoded
  });
});

// ── performance ──────────────────────────────────────────────────────

describe('compressImageForModel — performance', () => {
  it('fast path is codec-free and quick across many calls', async () => {
    const png = await solidPng(200, 200);
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      const result = await compressImageForModel(png, 'image/png');
      expect(result.data).toBe(png); // proves no decode/encode happened
    }
    const elapsed = performance.now() - start;
    // 100 metadata-only checks should be well under 100ms.
    expect(elapsed).toBeLessThan(100);
  });

  it('compresses a large image within a generous time bound', async () => {
    const png = await solidPng(3000, 2000);
    const start = performance.now();
    const result = await compressImageForModel(png, 'image/png');
    const elapsed = performance.now() - start;
    expect(result.changed).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it('exposes a sane default budget', () => {
    expect(IMAGE_BYTE_BUDGET).toBeGreaterThan(0);
    expect(MAX_IMAGE_EDGE_PX).toBe(2000);
  });
});

// ── content-part helper ──────────────────────────────────────────────

describe('compressImageContentParts', () => {
  function dataUrl(mime: string, bytes: Uint8Array): string {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  it('compresses an oversized inline image part, leaving other parts untouched', async () => {
    const big = await solidPng(2600, 2600);
    const parts = [
      { type: 'text' as const, text: 'look at this' },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big) } },
    ];
    const out = await compressImageContentParts(parts);

    expect(out[0]).toEqual({ type: 'text', text: 'look at this' });
    const imagePart = out[1];
    if (imagePart?.type !== 'image_url') throw new Error('expected image_url');
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(imagePart.imageUrl.url);
    expect(match).not.toBeNull();
    const dims = sniffImageDimensions(Buffer.from(match![2]!, 'base64'));
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
  });

  it('preserves the part identity for a within-budget image (no change)', async () => {
    const small = await solidPng(48, 48);
    const url = dataUrl('image/png', small);
    const parts = [{ type: 'image_url' as const, imageUrl: { url } }];
    const out = await compressImageContentParts(parts);
    expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url } });
  });

  it('leaves remote (non-data) image URLs untouched', async () => {
    const parts = [
      { type: 'image_url' as const, imageUrl: { url: 'https://example.com/pic.png' } },
    ];
    const out = await compressImageContentParts(parts);
    expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } });
  });

  it('keeps an image part id when rewriting the compressed url', async () => {
    const big = await solidPng(2600, 2600);
    const parts = [
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big), id: 'att-1' } },
    ];
    const out = await compressImageContentParts(parts);
    const imagePart = out[0];
    if (imagePart?.type !== 'image_url') throw new Error('expected image_url');
    expect(imagePart.imageUrl.id).toBe('att-1');
    expect(imagePart.imageUrl.url).not.toBe(dataUrl('image/png', big));
  });
});

// ── original-dimension metadata ──────────────────────────────────────

describe('compressImageForModel — original dimensions metadata', () => {
  it('reports original dimensions on passthrough and compressed results', async () => {
    const small = await solidPng(64, 64);
    const pass = await compressImageForModel(small, 'image/png');
    expect(pass.changed).toBe(false);
    expect(pass.originalWidth).toBe(64);
    expect(pass.originalHeight).toBe(64);

    const big = await solidPng(3000, 1500);
    const shrunk = await compressImageForModel(big, 'image/png');
    expect(shrunk.changed).toBe(true);
    expect(shrunk.originalWidth).toBe(3000);
    expect(shrunk.originalHeight).toBe(1500);
    expect(shrunk.width).toBe(2000);
  });

  it('reports original dimensions through the base64 wrapper', async () => {
    const big = await solidPng(2600, 1300);
    const base64 = Buffer.from(big).toString('base64');
    const result = await compressBase64ForModel(base64, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.originalWidth).toBe(2600);
    expect(result.originalHeight).toBe(1300);
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
  });
});

// ── crop ─────────────────────────────────────────────────────────────

describe('cropImageForModel', () => {
  it('crops a region out of a PNG at native resolution', async () => {
    const png = await solidPng(3000, 1500);
    const result = await cropImageForModel(png, 'image/png', {
      x: 100,
      y: 200,
      width: 500,
      height: 400,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(500);
    expect(result.height).toBe(400);
    expect(result.originalWidth).toBe(3000);
    expect(result.originalHeight).toBe(1500);
    expect(result.region).toEqual({ x: 100, y: 200, width: 500, height: 400 });
    expect(result.resized).toBe(false);
    expect(result.mimeType).toBe('image/png');
    expect(sniffImageDimensions(result.data)).toEqual({ width: 500, height: 400 });
  });

  it('preserves the JPEG format when cropping a JPEG', async () => {
    const jpeg = await solidJpeg(2400, 1200);
    const result = await cropImageForModel(jpeg, 'image/jpeg', {
      x: 0,
      y: 0,
      width: 300,
      height: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('clamps a region that overflows the image bounds', async () => {
    const png = await solidPng(3000, 1500);
    const result = await cropImageForModel(png, 'image/png', {
      x: 2500,
      y: 1000,
      width: 1000,
      height: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.region).toEqual({ x: 2500, y: 1000, width: 500, height: 500 });
    expect(result.width).toBe(500);
    expect(result.height).toBe(500);
  });

  it('rejects a region fully outside the image, naming the original size', async () => {
    const png = await solidPng(3000, 1500);
    const result = await cropImageForModel(png, 'image/png', {
      x: 3000,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('3000x1500');
  });

  it('downscales an oversized crop to the edge cap by default', async () => {
    const png = await solidPng(3000, 1500);
    const result = await cropImageForModel(png, 'image/png', {
      x: 0,
      y: 0,
      width: 2500,
      height: 1200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resized).toBe(true);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
    expect(result.region).toEqual({ x: 0, y: 0, width: 2500, height: 1200 });
  });

  it('keeps native resolution with skipResize', async () => {
    const png = await solidPng(3000, 1500);
    const result = await cropImageForModel(
      png,
      'image/png',
      { x: 0, y: 0, width: 2500, height: 1200 },
      { skipResize: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resized).toBe(false);
    expect(result.width).toBe(2500);
    expect(result.height).toBe(1200);
  });

  it('fails explicitly when a skipResize crop exceeds the byte budget', async () => {
    const png = await noisePng(900, 900);
    const result = await cropImageForModel(
      png,
      'image/png',
      { x: 0, y: 0, width: 900, height: 900 },
      { skipResize: true, byteBudget: 8 * 1024 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/smaller region/i);
  });

  it('rejects non-recodable formats explicitly', async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const result = await cropImageForModel(gif, 'image/gif', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/PNG and JPEG/);
  });

  it('rejects corrupt bytes without throwing', async () => {
    const corrupt = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const result = await cropImageForModel(corrupt, 'image/png', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects non-finite region coordinates with a clean error', async () => {
    // NaN slips past every `<`/`>=` comparison, so without an explicit guard
    // it reaches jimp and surfaces as a misleading internal validation dump.
    const png = await solidPng(300, 200);
    for (const region of [
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.NaN, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 10, height: Number.NaN },
    ]) {
      const result = await cropImageForModel(png, 'image/png', region);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(/finite/i);
      expect(result.error).not.toMatch(/Failed to decode/);
    }
  });

  it('refuses to decode a decompression bomb', async () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(30000, 16);
    header.writeUInt32BE(30000, 20);
    const result = await cropImageForModel(new Uint8Array(header), 'image/png', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.ok).toBe(false);
  });
});

// ── compression caption ──────────────────────────────────────────────

describe('buildImageCompressionCaption', () => {
  it('describes the original and sent variants with a readback path', () => {
    const caption = buildImageCompressionCaption({
      original: { width: 5184, height: 3456, byteLength: 13002342, mimeType: 'image/png' },
      final: { width: 2000, height: 1333, byteLength: 1153433, mimeType: 'image/jpeg' },
      originalPath: '/tmp/originals/ab.png',
    });
    expect(caption).toMatch(/^<system>.*<\/system>$/s);
    expect(caption).toContain('5184x3456 image/png (12.4 MB)');
    expect(caption).toContain('2000x1333 image/jpeg (1.1 MB)');
    expect(caption).toContain('/tmp/originals/ab.png');
    expect(caption).toContain('region');
  });

  it('omits dimensions when unknown and notes a missing original', () => {
    const caption = buildImageCompressionCaption({
      original: { width: 0, height: 0, byteLength: 5 * 1024 * 1024, mimeType: 'image/png' },
      final: { width: 0, height: 0, byteLength: 1024 * 1024, mimeType: 'image/jpeg' },
    });
    expect(caption).not.toContain('0x0');
    expect(caption).toContain('image/png (5.0 MB)');
    expect(caption).toContain('image/jpeg (1.0 MB)');
    expect(caption).toMatch(/not preserved/i);
  });
});

describe('extractImageCompressionCaptions', () => {
  const caption = buildImageCompressionCaption({
    original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
    final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
    originalPath: '/tmp/originals/shot.png',
  });

  it('extracts a standalone caption, unwrapping the <system> tag', () => {
    const result = extractImageCompressionCaptions(caption);
    expect(result.captions).toHaveLength(1);
    expect(result.captions[0]).toContain('Image compressed to fit model limits');
    expect(result.captions[0]).toContain('/tmp/originals/shot.png');
    expect(result.captions[0]).not.toContain('<system>');
    expect(result.text).toBe('');
  });

  it('extracts a caption merged into surrounding user text', () => {
    const result = extractImageCompressionCaptions(`能展示但是没有快捷键提示${caption}`);
    expect(result.captions).toHaveLength(1);
    expect(result.text).toBe('能展示但是没有快捷键提示');
  });

  it('extracts multiple captions from one text', () => {
    const other = buildImageCompressionCaption({
      original: { width: 4000, height: 3000, byteLength: 9 * 1024 * 1024, mimeType: 'image/jpeg' },
      final: { width: 2000, height: 1500, byteLength: 1024 * 1024, mimeType: 'image/jpeg' },
      originalPath: '/tmp/originals/photo.jpg',
    });
    const result = extractImageCompressionCaptions(`看这两张图${caption}${other}`);
    expect(result.captions).toHaveLength(2);
    expect(result.captions[0]).toContain('/tmp/originals/shot.png');
    expect(result.captions[1]).toContain('/tmp/originals/photo.jpg');
    expect(result.text).toBe('看这两张图');
  });

  it('leaves non-caption <system> blocks and plain text untouched', () => {
    const toolStatus = '<system>ERROR: Tool execution failed.</system>';
    expect(extractImageCompressionCaptions(toolStatus)).toEqual({
      captions: [],
      text: toolStatus,
    });
    expect(extractImageCompressionCaptions('just some text')).toEqual({
      captions: [],
      text: 'just some text',
    });
  });
});

// ── content-part annotation ──────────────────────────────────────────

describe('compressImageContentParts — annotate', () => {
  function dataUrl(mime: string, bytes: Uint8Array): string {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  it('inserts a caption before a compressed image and persists the original', async () => {
    const big = await solidPng(2600, 2600);
    const persisted: { bytes: Uint8Array; mimeType: string }[] = [];
    const parts = [{ type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big) } }];
    const out = await compressImageContentParts(parts, {
      annotate: {
        persistOriginal: (bytes, mimeType) => {
          persisted.push({ bytes, mimeType });
          return Promise.resolve('/tmp/originals/big.png');
        },
      },
    });

    expect(out).toHaveLength(2);
    const caption = out[0];
    if (caption?.type !== 'text') throw new Error('expected caption text part');
    expect(caption.text).toContain('2600x2600');
    expect(caption.text).toContain('/tmp/originals/big.png');
    expect(out[1]?.type).toBe('image_url');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.mimeType).toBe('image/png');
    expect(persisted[0]?.bytes.length).toBe(big.length);
  });

  it('adds no caption when the image passes through unchanged', async () => {
    const small = await solidPng(48, 48);
    const url = dataUrl('image/png', small);
    const out = await compressImageContentParts([{ type: 'image_url' as const, imageUrl: { url } }], {
      annotate: {},
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url } });
  });

  it('captions without a path when persistence fails', async () => {
    const big = await solidPng(2600, 2600);
    const parts = [{ type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big) } }];
    const out = await compressImageContentParts(parts, {
      annotate: { persistOriginal: () => Promise.resolve(null) },
    });
    expect(out).toHaveLength(2);
    const caption = out[0];
    if (caption?.type !== 'text') throw new Error('expected caption text part');
    expect(caption.text).toMatch(/not preserved/i);
  });
});
