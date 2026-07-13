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
 *   - annotate: compressImageContentParts can collect that caption for
 *     each compressed image and persist the original via a callback
 *   - quality guards: a 1px checkerboard downscales to flat gray (no
 *     spectral aliasing) at integer and fractional ratios, with jimp's
 *     point-sampled BILINEAR mode pinned as the aliasing counter-example;
 *     fully transparent pixels never bleed color into opaque edges; mean
 *     brightness survives the downscale; recompressing a compressed
 *     result is a no-op; extreme aspect ratios never collapse to zero
 */

import { createRequire } from 'node:module';

import { Jimp, ResizeStrategy } from 'jimp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildImageCompressionCaption,
  compressBase64ForModel,
  compressImageContentParts,
  compressImageForModel,
  cropImageForModel,
  extractImageCompressionCaptions,
  gateImageFormatParts,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
  READ_IMAGE_BYTE_BUDGET,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  setConfiguredMaxImageEdgePx,
  setConfiguredReadImageByteBudget,
  type ImageCompressionTelemetryClient,
} from '#/agent/media/image-compress';
import { sniffImageDimensions } from '#/agent/media/file-type';
import {
  normalizeImageMime,
  unsupportedImageMimeFromUrl,
} from '#/agent/media/image-format-policy';

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

/**
 * Statistically random (deterministic xorshift) noise. Unlike noisePng's
 * periodic pattern — whose post-resize deflate size is unpredictable — this
 * stays roughly proportionally incompressible after a resize smooths it,
 * so byte sizes can be compared across scales.
 */
async function randomNoisePng(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  fillXorshiftNoise(image.bitmap.data);
  return new Uint8Array(await image.getBuffer('image/png'));
}

/** JPEG twin of {@link randomNoisePng}, for exercising the JPEG source path. */
async function randomNoiseJpeg(width: number, height: number): Promise<Uint8Array> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  fillXorshiftNoise(image.bitmap.data);
  return new Uint8Array(await image.getBuffer('image/jpeg', { quality: 90 }));
}

function fillXorshiftNoise(data: Buffer | Uint8Array): void {
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= (state << 13) >>> 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state & 0xff;
  };
  for (let i = 0; i < data.length; i += 4) {
    data[i] = next();
    data[i + 1] = next();
    data[i + 2] = next();
    data[i + 3] = 0xff;
  }
}

async function decodeAlpha(bytes: Uint8Array): Promise<boolean> {
  const image = await Jimp.fromBuffer(Buffer.from(bytes));
  return image.hasAlpha();
}

async function encodeWebp(
  image: { bitmap: { data: Buffer | Uint8Array; width: number; height: number } },
  quality = 90,
): Promise<Uint8Array> {
  const requireLocal = createRequire(import.meta.url);
  const encMod = (await import(
    requireLocal.resolve('@jsquash/webp/encode.js')
  )) as typeof import('@jsquash/webp/encode.js');
  const { readFileSync } = await import('node:fs');
  // The repo tsconfig has no DOM lib, so the global WebAssembly name is
  // reached structurally (same approach as the production decoder).
  const wasmNamespace = (
    globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } }
  ).WebAssembly;
  const wasm = await wasmNamespace.compile(
    readFileSync(requireLocal.resolve('@jsquash/webp/codec/enc/webp_enc.wasm')),
  );
  await encMod.init(wasm as never);
  const { bitmap } = image;
  const encoded = await encMod.default(
    {
      data: new Uint8ClampedArray(
        bitmap.data.buffer,
        bitmap.data.byteOffset,
        bitmap.data.byteLength,
      ),
      width: bitmap.width,
      height: bitmap.height,
    } as never,
    { quality },
  );
  return new Uint8Array(encoded);
}

/** Minimal VP8X container header with the ANIM flag set. */
function animatedWebpHeader(): Uint8Array {
  const bytes = new Uint8Array(30);
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.codePointAt(i)!;
  };
  ascii('RIFF', 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  ascii('WEBP', 8);
  ascii('VP8X', 12);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes[20] = 0x02; // ANIM flag
  return bytes;
}

/**
 * Insert a minimal EXIF APP1 segment carrying only an Orientation tag right
 * after the JPEG SOI marker (jimp itself never writes EXIF).
 */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  // TIFF body, little-endian: 8-byte header + IFD0 with a single entry.
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // offset of IFD0
  tiff.writeUInt16LE(1, 8); // one directory entry
  tiff.writeUInt16LE(0x0112, 10); // tag: Orientation
  tiff.writeUInt16LE(3, 12); // type: SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value, left-aligned in the 4-byte field
  tiff.writeUInt32LE(0, 22); // no next IFD
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xff_e1, 0);
  app1Header.writeUInt16BE(exifBody.length + 2, 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(jpeg.subarray(0, 2)), // SOI
      app1Header,
      exifBody,
      Buffer.from(jpeg.subarray(2)),
    ]),
  );
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
    const png = await solidPng(2100, 1050);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
    // 2100x1050 → 2000x1000 (aspect 2:1 preserved).
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1000);
    const dims = sniffImageDimensions(result.data);
    expect(dims).toEqual({ width: 2000, height: 1000 });
  });

  it('respects a custom maxEdge', async () => {
    const png = await solidPng(1000, 500);
    const result = await compressImageForModel(png, 'image/png', { maxEdge: 800 });
    expect(result.changed).toBe(true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it('keeps a downscaled opaque PNG lossless (no needless JPEG conversion)', async () => {
    // A screenshot-like opaque PNG that only needs downscaling must stay PNG so
    // sharp text is not degraded by JPEG artifacts.
    const png = await solidPng(2100, 1050);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
  });
});

// ── byte budget ──────────────────────────────────────────────────────

describe('compressImageForModel — byte budget', () => {
  it('walks the JPEG ladder for an over-budget non-alpha image', async () => {
    const png = await noisePng(500, 500);
    const result = await compressImageForModel(png, 'image/png', { byteBudget: 8 * 1024 });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.finalByteLength).toBeLessThan(result.originalByteLength);
  });

  it('keeps a translucent PNG as PNG when the budget allows', async () => {
    const png = await translucentPng(2100, 1050);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(Math.max(result.width, result.height)).toBe(MAX_IMAGE_EDGE_PX);
    expect(await decodeAlpha(result.data)).toBe(true);
  });

  it('drops alpha to JPEG only as a last resort under a tiny budget', async () => {
    const png = await noisePng(400, 400, /* alpha */ true);
    const result = await compressImageForModel(png, 'image/png', { byteBudget: 4 * 1024 });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.finalByteLength).toBeLessThan(result.originalByteLength);
  });

  it('steps down through the 2000px edge before the 1000px fallback', async () => {
    // Regression guard for the 3000px cap raise: a PNG whose fitted encode
    // is over budget but whose 2000px encode fits must come back at 2000px
    // (as it did under the old cap), not skip straight to 1000px.
    // The budget is anchored to the actual 2000px encode size (probed with
    // an unlimited budget) so the test does not depend on exact deflate
    // output sizes.
    const png = await randomNoisePng(2400, 600);
    const probe = await compressImageForModel(png, 'image/png', {
      maxEdge: 2000,
      byteBudget: Number.MAX_SAFE_INTEGER,
    });
    expect(probe.changed).toBe(true);
    expect(probe.mimeType).toBe('image/png');
    expect(Math.max(probe.width, probe.height)).toBe(2000);
    // Sanity: the anchor budget must sit below the input size, or the run
    // below would pass through on the fast path instead of re-encoding.
    expect(probe.finalByteLength + 1024).toBeLessThan(png.length);

    const result = await compressImageForModel(png, 'image/png', {
      byteBudget: probe.finalByteLength + 1024,
    });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(Math.max(result.width, result.height)).toBe(2000);
  });

  it(
    're-runs the JPEG quality ladder at fallback sizes instead of jumping to q20',
    async () => {
      // A JPEG whose quality ladder fails at every size above 1000px, with the
      // budget tuned so that at 1000px a mid-quality (q60) encode fits. The
      // fallback must walk the ladder again and return that q60 encode — not
      // collapse straight to q20 and needlessly destroy detail.
      // The probe replays the implementation's exact resize chain
      // (2400 → 2000 → 1000): box-resizing twice does not yield the same
      // bitmap as resizing once, and JPEG encoding is deterministic, so the
      // probed q60 size matches the implementation's encode byte-for-byte.
      // The width must exceed 2000px to exercise the full fallback chain; the
      // height is kept small so the ~11 JPEG encodes stay fast on slow CI.
      const jpeg = await randomNoiseJpeg(2400, 300);
      const probe = await Jimp.fromBuffer(Buffer.from(jpeg));
      probe.resize({ w: 2000, h: 250 });
      probe.resize({ w: 1000, h: 125 });
      const q60Size = (await probe.getBuffer('image/jpeg', { quality: 60 })).length;
      const q20Size = (await probe.getBuffer('image/jpeg', { quality: 20 })).length;
      expect(q60Size).toBeGreaterThan(q20Size); // sanity: the anchor separates the rungs

      const result = await compressImageForModel(jpeg, 'image/jpeg', {
        byteBudget: q60Size + 256,
      });
      expect(result.changed).toBe(true);
      expect(result.mimeType).toBe('image/jpeg');
      expect(Math.max(result.width, result.height)).toBe(1000);
      // The highest quality that fits the budget at 1000px is q60.
      expect(result.finalByteLength).toBe(q60Size);
    },
    15_000,
  );
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

  it('passes a tiny within-budget WebP through untouched (fast path)', async () => {
    // Too small to be worth re-encoding: already within both budgets, so the
    // fast path returns it before any codec is loaded.
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
    const png = await solidPng(2100, 100);
    const result = await compressImageForModel(png, 'image/png', { maxDecodeBytes: 64 });
    expect(result.changed).toBe(false);
    expect(result.data).toBe(png); // passthrough → Jimp was never called
  });
});

// ── webp ─────────────────────────────────────────────────────────────

describe('compressImageForModel — webp', () => {
  it(
    'downscales an oversized WebP to the edge cap',
    async () => {
      const source = new Jimp({ width: 2100, height: 1050, color: 0x3366ccff });
      const webp = await encodeWebp(source);
      const result = await compressImageForModel(webp, 'image/webp');
      expect(result.changed).toBe(true);
      expect(Math.max(result.width, result.height)).toBe(2000);
      expect(result.originalWidth).toBe(2100);
      expect(result.originalHeight).toBe(1050);
      expect(sniffImageDimensions(result.data)).toEqual({ width: 2000, height: 1000 });
    },
    15_000,
  );

  it(
    're-encodes an over-budget WebP within the byte budget',
    async () => {
      const budget = 128 * 1024;
      const noisy = new Jimp({ width: 700, height: 700, color: 0x000000ff });
      fillXorshiftNoise(noisy.bitmap.data);
      const webp = await encodeWebp(noisy, 100);
      expect(webp.length).toBeGreaterThan(budget);
      const result = await compressImageForModel(webp, 'image/webp', { byteBudget: budget });
      expect(result.changed).toBe(true);
      expect(result.finalByteLength).toBeLessThanOrEqual(budget);
    },
    15_000,
  );

  it(
    'keeps alpha when re-encoding a translucent WebP',
    async () => {
      const translucent = new Jimp({ width: 2100, height: 1050, color: 0x33_66_cc_80 });
      const webp = await encodeWebp(translucent);
      const result = await compressImageForModel(webp, 'image/webp');
      expect(result.changed).toBe(true);
      expect(result.mimeType).toBe('image/png');
      expect(await decodeAlpha(result.data)).toBe(true);
    },
    15_000,
  );

  it('passes an animated WebP through to preserve animation', async () => {
    const animated = animatedWebpHeader();
    const result = await compressImageForModel(animated, 'image/webp');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(animated);
  });

  it(
    'crops a region out of a WebP',
    async () => {
      const source = new Jimp({ width: 800, height: 400, color: 0x3366ccff });
      const webp = await encodeWebp(source);
      const result = await cropImageForModel(webp, 'image/webp', {
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.width).toBe(300);
      expect(result.height).toBe(200);
      expect(result.originalWidth).toBe(800);
      expect(result.originalHeight).toBe(400);
    },
    15_000,
  );

  it('refuses to crop an animated WebP', async () => {
    const result = await cropImageForModel(animatedWebpHeader(), 'image/webp', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('animated WebP');
  });
});

// ── invariants ───────────────────────────────────────────────────────

describe('compressImageForModel — invariants', () => {
  it('changed always yields a within-cap, decodable payload', async () => {
    const cases: Uint8Array[] = [
      await solidPng(2100, 1050),
      await noisePng(400, 400),
      await translucentPng(2100, 1050),
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
  }, 30000);
});

// ── base64 wrapper ───────────────────────────────────────────────────

describe('compressBase64ForModel', () => {
  it('round-trips an over-sized image', async () => {
    const png = await noisePng(500, 500);
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
    const png = await solidPng(2100, 100); // over edge, would otherwise compress
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
    const png = await solidPng(2100, 1050);
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
    const big = await solidPng(2100, 1050);
    const parts = [
      { type: 'text' as const, text: 'look at this' },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big) } },
    ];
    const { parts: out } = await compressImageContentParts(parts);

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
    const { parts: out } = await compressImageContentParts(parts);
    expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url } });
  });

  it('leaves remote (non-data) image URLs untouched', async () => {
    const parts = [
      { type: 'image_url' as const, imageUrl: { url: 'https://example.com/pic.png' } },
    ];
    const { parts: out } = await compressImageContentParts(parts);
    expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } });
  });

  it('keeps an image part id when rewriting the compressed url', async () => {
    const big = await solidPng(2100, 1050);
    const parts = [
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big), id: 'att-1' } },
    ];
    const { parts: out } = await compressImageContentParts(parts);
    const imagePart = out[0];
    if (imagePart?.type !== 'image_url') throw new Error('expected image_url');
    expect(imagePart.imageUrl.id).toBe('att-1');
    expect(imagePart.imageUrl.url).not.toBe(dataUrl('image/png', big));
  });

  it('drops image parts the provider cannot accept, replacing each with a notice', async () => {
    // MCP servers can return any image/* MIME (e.g. an AVIF from an image
    // search tool). Forwarding it would poison the session history, so the
    // part is dropped and a text notice stands in.
    const parts = [
      { type: 'text' as const, text: 'search results' },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/avif', new Uint8Array([1, 2, 3])) } },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/heic', new Uint8Array([4, 5, 6])) } },
    ];
    const { parts: out, captions } = await compressImageContentParts(parts);

    expect(out[0]).toEqual({ type: 'text', text: 'search results' });
    expect(out.some((p) => p.type === 'image_url')).toBe(false);
    const notices = out.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
    expect(notices.some((t) => t.includes('image/avif'))).toBe(true);
    expect(notices.some((t) => t.includes('image/heic'))).toBe(true);
    // Dropping is not compression: no captions are produced.
    expect(captions).toEqual([]);
  });

  it('passes the accepted formats through the format gate untouched', async () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const url = dataUrl(mime, new Uint8Array([1, 2, 3]));
      const parts = [{ type: 'image_url' as const, imageUrl: { url } }];
      const { parts: out } = await compressImageContentParts(parts);
      expect(out[0]).toEqual({ type: 'image_url', imageUrl: { url } });
    }
  });

  it('forwards accepted MIME aliases in canonical form', async () => {
    // `image/jpg` (and case/whitespace variants) pass the gate, but the raw
    // alias must not land in the session: strict provider whitelists (e.g.
    // Anthropic's) reject it and every later request would fail.
    const bytes = new Uint8Array([1, 2, 3]);
    const base64 = Buffer.from(bytes).toString('base64');
    for (const alias of ['image/jpg', 'Image/JPEG', ' image/jpeg ']) {
      const parts = [
        { type: 'image_url' as const, imageUrl: { url: `data:${alias};base64,${base64}` } },
      ];
      const { parts: out, captions } = await compressImageContentParts(parts);
      expect(out[0]).toEqual({
        type: 'image_url',
        imageUrl: { url: `data:image/jpeg;base64,${base64}` },
      });
      // Rewriting the MIME is not compression: no caption.
      expect(captions).toEqual([]);
    }
  });

  it('drops an unsupported image even when its data URL carries MIME parameters', async () => {
    const parts = [
      {
        type: 'image_url' as const,
        imageUrl: { url: dataUrl('image/avif;charset=utf-8', new Uint8Array([1, 2, 3])) },
      },
    ];
    const { parts: out } = await compressImageContentParts(parts);
    expect(out.some((p) => p.type === 'image_url')).toBe(false);
    expect(out[0]).toMatchObject({ type: 'text' });
    expect((out[0] as { text: string }).text).toContain('image/avif');
  });
});

// ── format gate (shared by every ingestion point) ────────────────────

describe('gateImageFormatParts', () => {
  function dataUrl(mime: string, bytes: Uint8Array): string {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }

  it('replaces every unsupported inline image with a notice and keeps the rest', () => {
    const parts = [
      { type: 'text' as const, text: 'results' },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/avif', new Uint8Array([1])) } },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/bmp', new Uint8Array([2])) } },
      { type: 'video_url' as const, videoUrl: { url: dataUrl('video/mp4', new Uint8Array([3])) } },
      { type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', new Uint8Array([4])) } },
    ];
    const out = gateImageFormatParts(parts);

    expect(out[0]).toEqual({ type: 'text', text: 'results' });
    // Both unsupported images became notices naming their MIME.
    const notices = out.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
    expect(notices.some((t) => t.includes('image/avif'))).toBe(true);
    expect(notices.some((t) => t.includes('image/bmp'))).toBe(true);
    // Video parts and the accepted image pass through untouched.
    expect(out).toContainEqual(parts[3]);
    expect(out).toContainEqual(parts[4]);
    expect(
      out.some(
        (p) => p.type === 'image_url' && !p.imageUrl.url.startsWith('data:image/png'),
      ),
    ).toBe(false);
  });

  it('rewrites accepted MIME aliases to canonical form', () => {
    const base64 = Buffer.from([1, 2, 3]).toString('base64');
    const out = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/jpg;base64,${base64}` } },
    ]);
    expect(out[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/jpeg;base64,${base64}` },
    });
  });

  it('rewrites an accepted MIME carrying parameters to the bare canonical form', () => {
    // Strict provider whitelists exact-match the full data-URL header, so
    // `image/jpeg;charset=utf-8` would be rejected just like an alias.
    const base64 = Buffer.from([1, 2, 3]).toString('base64');
    const out = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/jpeg;charset=utf-8;base64,${base64}` } },
    ]);
    expect(out[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/jpeg;base64,${base64}` },
    });
  });

  it('gates on the sniffed bytes, not the declared MIME', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const ftyp = (brand: string): Buffer => {
      const buf = Buffer.alloc(16);
      buf.writeUInt32BE(16, 0);
      buf.write('ftyp', 4, 'latin1');
      buf.write(brand, 8, 'latin1');
      return buf;
    };

    // AVIF bytes labeled image/png (a mislabeling MCP image search tool):
    // dropped as the AVIF it is — the provider decodes bytes, not labels.
    const mislabeled = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/png;base64,${ftyp('avif').toString('base64')}` } },
    ]);
    expect(mislabeled.some((p) => p.type === 'image_url')).toBe(false);
    expect((mislabeled[0] as { text: string }).text).toContain('image/avif');

    // A video container hiding in an image part is refused too.
    const video = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/png;base64,${ftyp('isom').toString('base64')}` } },
    ]);
    expect(video.some((p) => p.type === 'image_url')).toBe(false);
    expect((video[0] as { text: string }).text).toContain('video/mp4');

    // PNG bytes labeled image/avif: rescued — forwarded as the PNG it is.
    const rescued = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/avif;base64,${pngBytes.toString('base64')}` } },
    ]);
    expect(rescued[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/png;base64,${pngBytes.toString('base64')}` },
    });

    // Unrecognized bytes (corrupt image): the declared MIME stands; the
    // 400-recovery path is the backstop for this case.
    const garbage = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` } },
    ]);
    expect(garbage[0]).toMatchObject({ type: 'image_url' });
  });

  it('parses the base64 marker case-insensitively', () => {
    // `;BASE64,` is a legal data URL (RFC 2045 encoding names are
    // case-insensitive): an uppercase marker must not slip past the gate as
    // if it were a remote URL, and the canonical rebuild lowercases it.
    const base64 = Buffer.from([1, 2, 3]).toString('base64');

    const accepted = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/jpeg;BASE64,${base64}` } },
    ]);
    expect(accepted[0]).toEqual({
      type: 'image_url',
      imageUrl: { url: `data:image/jpeg;base64,${base64}` },
    });

    const unsupported = gateImageFormatParts([
      { type: 'image_url', imageUrl: { url: `data:image/avif;BASE64,${base64}` } },
    ]);
    expect(unsupported.some((p) => p.type === 'image_url')).toBe(false);
    expect((unsupported[0] as { text: string }).text).toContain('image/avif');
  });

  it('drops remote image URLs whose extension is unsupported, passes others through', () => {
    // No bytes to inspect, so the gate uses the path extension: a known-bad
    // extension becomes a notice; extensionless / unknown / accepted
    // extensions pass through to the provider (and the 400 recovery).
    for (const bad of [
      'https://example.com/pic.avif',
      'https://example.com/pic.AVIF',
      'https://example.com/pic.heic?size=full',
      'https://example.com/scan.tiff#frame',
      'https://example.com/icon.ico',
      'https://example.com/logo.svg',
    ]) {
      const out = gateImageFormatParts([{ type: 'image_url', imageUrl: { url: bad } }]);
      expect(out[0]).toMatchObject({ type: 'text' });
      // The notice keeps the URL so the model can fetch and convert the image.
      expect((out[0] as { text: string }).text).toContain(bad);
    }
    for (const ok of [
      'https://example.com/pic.png',
      'https://example.com/pic.jpg?size=full#frame',
      'https://example.com/avatar',
      'https://cdn.example.com/v2/image?id=123',
    ]) {
      const part = { type: 'image_url' as const, imageUrl: { url: ok } };
      expect(gateImageFormatParts([part])).toEqual([part]);
    }
  });

  it('drops a malformed data URL instead of letting it poison the session', () => {
    // A `data:` URL parseImageDataUrl cannot parse is guaranteed to fail at
    // the provider (Anthropic throws, OpenAI-compat 400s): dropping it at
    // ingestion beats paying a rejected request + media strip every turn.
    const cases = [
      'data:image/avif',
      'data:image/png;notbase64,QUJD',
      'data:;base64,QUJD',
      'data:image/png;base64',
      'DATA:image/avif',
    ];
    for (const url of cases) {
      const out = gateImageFormatParts([{ type: 'image_url', imageUrl: { url } }]);
      expect(out.some((p) => p.type === 'image_url')).toBe(false);
      expect(out[0]).toMatchObject({ type: 'text' });
      expect((out[0] as { text: string }).text).toContain('not a valid data URL');
    }
  });

  it('truncates a long malformed data URL in the notice', () => {
    const url = `data:image/png${'x'.repeat(500)}`;
    const out = gateImageFormatParts([{ type: 'image_url', imageUrl: { url } }]);
    const notice = (out[0] as { text: string }).text;
    expect(notice.length).toBeLessThan(250);
    expect(notice).not.toContain(url);
  });
});

describe('normalizeImageMime', () => {
  it('lowercases, strips MIME parameters, and applies the jpg alias', () => {
    expect(normalizeImageMime('image/png')).toBe('image/png');
    expect(normalizeImageMime('Image/JPEG')).toBe('image/jpeg');
    expect(normalizeImageMime('image/jpg')).toBe('image/jpeg');
    expect(normalizeImageMime(' image/webp ')).toBe('image/webp');
    // Parameters (e.g. charset) are dropped so a declared media type stays
    // consistent with a data-URL MIME token.
    expect(normalizeImageMime('image/jpeg; charset=utf-8')).toBe('image/jpeg');
    expect(normalizeImageMime('IMAGE/PNG;foo=bar')).toBe('image/png');
  });
});

describe('unsupportedImageMimeFromUrl', () => {
  it('flags known-unsupported extensions and ignores query/fragment/case', () => {
    expect(unsupportedImageMimeFromUrl('https://example.com/pic.avif')).toBe('image/avif');
    expect(unsupportedImageMimeFromUrl('https://example.com/pic.AVIF?x=1')).toBe('image/avif');
    expect(unsupportedImageMimeFromUrl('https://example.com/photo.HEIC#frame')).toBe('image/heic');
    expect(unsupportedImageMimeFromUrl('https://example.com/scan.tiff')).toBe('image/tiff');
    expect(unsupportedImageMimeFromUrl('https://example.com/icon.ico')).toBe('image/x-icon');
    // .svg is not in the shared suffix map (SVG is text for the file tools),
    // but remote SVG images are accepted by no provider.
    expect(unsupportedImageMimeFromUrl('https://example.com/logo.svg')).toBe('image/svg+xml');
    expect(unsupportedImageMimeFromUrl('https://example.com/logo.svgz')).toBe('image/svg+xml');
  });

  it('returns null for accepted, extensionless, or unknown URLs', () => {
    expect(unsupportedImageMimeFromUrl('https://example.com/pic.png')).toBeNull();
    expect(unsupportedImageMimeFromUrl('https://example.com/pic.jpg')).toBeNull();
    expect(unsupportedImageMimeFromUrl('https://example.com/avatar')).toBeNull();
    expect(unsupportedImageMimeFromUrl('https://cdn.example.com/v2/image?id=123')).toBeNull();
    expect(unsupportedImageMimeFromUrl('https://example.com/readme.json')).toBeNull();
  });
});

// ── original-dimension metadata ──────────────────────────────────────

describe('compressImageForModel — EXIF orientation', () => {
  it('reports original dimensions in the decoded (EXIF-rotated) space', async () => {
    // Orientation 6 (rotate 90° CW): the file header says 120x80, but jimp
    // decodes to 80x120 — the space the sent image and any later crop region
    // actually live in. The reported original dimensions must match it, not
    // the pre-rotation header sniff.
    const jpeg = withExifOrientation(await solidJpeg(120, 80), 6);
    const result = await compressImageForModel(jpeg, 'image/jpeg', { maxEdge: 64 });
    expect(result.changed).toBe(true);
    expect(result.originalWidth).toBe(80);
    expect(result.originalHeight).toBe(120);
    // The sent image keeps the rotated (portrait) aspect.
    expect(result.width).toBeLessThan(result.height);
  });

  it('reports display-space dimensions for an EXIF-rotated passthrough', async () => {
    // Within both budgets → no decode ever happens. The header sniff itself
    // must account for EXIF orientation so passthrough metadata agrees with
    // the space a later region readback (which decodes) will use.
    const jpeg = withExifOrientation(await solidJpeg(120, 80), 6);
    const result = await compressImageForModel(jpeg, 'image/jpeg');
    expect(result.changed).toBe(false);
    expect(result.data).toBe(jpeg); // fast path — not decoded
    expect(result.originalWidth).toBe(80);
    expect(result.originalHeight).toBe(120);
    expect(result.width).toBe(80);
    expect(result.height).toBe(120);
  });
});

describe('compressImageForModel — original dimensions metadata', () => {
  it('reports original dimensions on passthrough and compressed results', async () => {
    const small = await solidPng(64, 64);
    const pass = await compressImageForModel(small, 'image/png');
    expect(pass.changed).toBe(false);
    expect(pass.originalWidth).toBe(64);
    expect(pass.originalHeight).toBe(64);

    const big = await solidPng(2100, 1050);
    const shrunk = await compressImageForModel(big, 'image/png');
    expect(shrunk.changed).toBe(true);
    expect(shrunk.originalWidth).toBe(2100);
    expect(shrunk.originalHeight).toBe(1050);
    expect(shrunk.width).toBe(2000);
  });

  it('reports original dimensions through the base64 wrapper', async () => {
    const big = await solidPng(2100, 1050);
    const base64 = Buffer.from(big).toString('base64');
    const result = await compressBase64ForModel(base64, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.originalWidth).toBe(2100);
    expect(result.originalHeight).toBe(1050);
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
    const jpeg = await solidJpeg(800, 400);
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
    const png = await solidPng(2100, 1050);
    const result = await cropImageForModel(png, 'image/png', {
      x: 2100,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('2100x1050');
  });

  it('downscales an oversized crop to the edge cap by default', async () => {
    const png = await solidPng(2500, 1250);
    const result = await cropImageForModel(png, 'image/png', {
      x: 0,
      y: 0,
      width: 2400,
      height: 1200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resized).toBe(true);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);
    expect(result.region).toEqual({ x: 0, y: 0, width: 2400, height: 1200 });
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
    const png = await noisePng(400, 400);
    const result = await cropImageForModel(
      png,
      'image/png',
      { x: 0, y: 0, width: 400, height: 400 },
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
    expect(result.error).toMatch(/PNG, JPEG, and WebP/);
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

  it('collects a caption for a compressed image and persists the original', async () => {
    const big = await solidPng(2100, 1050);
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

    // The caption comes back as data, never inserted into the parts.
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]?.type).toBe('image_url');
    expect(out.captions).toHaveLength(1);
    expect(out.captions[0]).toContain('2100x1050');
    expect(out.captions[0]).toContain('/tmp/originals/big.png');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.mimeType).toBe('image/png');
    expect(persisted[0]?.bytes.length).toBe(big.length);
  });

  it('collects no caption when the image passes through unchanged', async () => {
    const small = await solidPng(48, 48);
    const url = dataUrl('image/png', small);
    const out = await compressImageContentParts([{ type: 'image_url' as const, imageUrl: { url } }], {
      annotate: {},
    });
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]).toEqual({ type: 'image_url', imageUrl: { url } });
    expect(out.captions).toEqual([]);
  });

  it('captions without a path when persistence fails', async () => {
    const big = await solidPng(2100, 1050);
    const parts = [{ type: 'image_url' as const, imageUrl: { url: dataUrl('image/png', big) } }];
    const out = await compressImageContentParts(parts, {
      annotate: { persistOriginal: () => Promise.resolve(null) },
    });
    expect(out.parts).toHaveLength(1);
    expect(out.captions).toHaveLength(1);
    expect(out.captions[0]).toMatch(/not preserved/i);
  });
});

// ── downscale quality guards ─────────────────────────────────────────
//
// Downscaling is a resampling operation: input frequencies above the output
// Nyquist limit must be filtered out (averaged), or they fold back as
// low-frequency moiré — spectral aliasing. A 1px checkerboard is the
// worst-case probe: ALL of its energy sits at the input Nyquist frequency,
// so a resampler that skips source pixels turns it into high-contrast
// artifacts, while a correct full-coverage average yields flat ~50% gray.
// These tests pin the compressor to the correct behavior, keep the aliasing
// counter-example executable, and cover the other classic downscale bugs
// (transparent-pixel bleed, brightness drift, iterative degradation,
// degenerate aspect ratios).

/** 1px checkerboard: every pixel alternates black/white in both axes. */
async function checkerboardPng(size: number): Promise<Uint8Array> {
  const image = new Jimp({ width: size, height: size, color: 0x000000ff });
  const data = image.bitmap.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = (x + y) % 2 === 0 ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 0xff;
    }
  }
  return new Uint8Array(await image.getBuffer('image/png'));
}

interface GrayStats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/** Min/max/mean over the red channel (all probes here are grayscale). */
function grayStats(image: { bitmap: { data: Buffer | Uint8Array } }): GrayStats {
  const data = image.bitmap.data;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / (data.length / 4) };
}

describe('compressImageForModel — downscale quality guards', () => {
  it('averages a 1px checkerboard to flat gray at an integer ratio (no aliasing)', async () => {
    // 1000 → 250 (4:1). Every output pixel covers a 4×4 block holding 8
    // black and 8 white pixels, so a full-coverage average lands on ~127.
    // Aliasing would instead show up as black/white patches or moiré bands.
    const png = await checkerboardPng(1000);
    const result = await compressImageForModel(png, 'image/png', { maxEdge: 250 });
    expect(result.changed).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(250);

    const decoded = await Jimp.fromBuffer(Buffer.from(result.data));
    const { min, max } = grayStats(decoded);
    expect(min).toBeGreaterThanOrEqual(118);
    expect(max).toBeLessThanOrEqual(138);
  });

  it('stays alias-free at a non-integer ratio (fractional pixel coverage)', async () => {
    // 1000 → 390 (≈2.56:1). Non-integer ratios are where phase-dependent
    // point sampling degrades worst. Fractional window coverage leaves the
    // average some mild texture, but nothing may approach black or white.
    const png = await checkerboardPng(1000);
    const result = await compressImageForModel(png, 'image/png', { maxEdge: 390 });
    expect(result.changed).toBe(true);

    const decoded = await Jimp.fromBuffer(Buffer.from(result.data));
    const { min, max } = grayStats(decoded);
    expect(min).toBeGreaterThanOrEqual(90);
    expect(max).toBeLessThanOrEqual(165);
  });

  it('control: jimp point-sampled BILINEAR aliases the same input (keeps the probe honest)', async () => {
    // Executable counter-example for the constraint documented on
    // fitWithinEdge: the named ResizeStrategy modes sample a fixed 2×2
    // neighborhood around the mapped point and skip the rest. At 4:1 the
    // sample grid lands on a single checkerboard phase and the 50%-gray
    // pattern collapses to solid black — the pattern's energy is entirely
    // misrepresented. This proves the two tests above can fail (the probe
    // distinguishes resamplers) and pins the library behavior the
    // mode-less default call relies on — if jimp ever changes either
    // side, revisit the fitWithinEdge comment.
    const image = await Jimp.fromBuffer(Buffer.from(await checkerboardPng(1000)));
    image.resize({ w: 250, h: 250, mode: ResizeStrategy.BILINEAR });
    const { min, max, mean } = grayStats(image);
    // The correct answer is flat ~127 gray (mean ≈ 127, max-min ≈ 0).
    // Aliasing shows up as a solid black/white collapse or full-contrast
    // banding — far from that answer regardless of sampling phase.
    const aliased = mean < 60 || mean > 195 || max - min > 200;
    expect(aliased).toBe(true);
  });

  it('never bleeds color from fully transparent pixels into visible ones', async () => {
    // Fully transparent pixels still carry RGB values. A resizer that
    // blends them into the average tints every transparency edge (halo).
    // Probe: a fully transparent BRIGHT RED field around an opaque blue
    // square — after a 4:1 downscale no visible pixel may pick up red.
    const size = 800;
    const image = new Jimp({ width: size, height: size, color: 0xff000000 }); // red, alpha 0
    const data = image.bitmap.data;
    for (let y = 200; y < 600; y += 1) {
      for (let x = 200; x < 600; x += 1) {
        const i = (y * size + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0xff;
        data[i + 3] = 0xff;
      }
    }
    const png = new Uint8Array(await image.getBuffer('image/png'));

    const result = await compressImageForModel(png, 'image/png', { maxEdge: 200 });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe('image/png'); // alpha survives

    const decoded = await Jimp.fromBuffer(Buffer.from(result.data));
    const out = decoded.bitmap.data;
    let visible = 0;
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3]! >= 8) {
        visible += 1;
        expect(out[i]!).toBeLessThanOrEqual(16); // red channel stays ~0
      }
    }
    expect(visible).toBeGreaterThan(0); // the blue square is still there
  });

  it('preserves mean brightness through the downscale (no energy drift)', async () => {
    // A normalized filter keeps the image mean; drift here would indicate
    // non-normalized weights (or a broken gamma pipeline stage).
    const png = await noisePng(400, 400);
    const input = await Jimp.fromBuffer(Buffer.from(png));
    const inputMean = grayStats(input).mean;

    const result = await compressImageForModel(png, 'image/png', { maxEdge: 100 });
    expect(result.changed).toBe(true);
    const output = await Jimp.fromBuffer(Buffer.from(result.data));
    expect(Math.abs(grayStats(output).mean - inputMean)).toBeLessThan(3);
  });

  it('recompressing a compressed result is a no-op (no iterative degradation)', async () => {
    // Model-bound bytes can re-enter the pipeline (session replay, MCP
    // round-trips). Once within budget they must pass through untouched
    // instead of being shaved a little smaller on every pass.
    const first = await compressImageForModel(await solidPng(2100, 1050), 'image/png');
    expect(first.changed).toBe(true);

    const second = await compressImageForModel(first.data, first.mimeType);
    expect(second.changed).toBe(false);
    expect(second.data).toBe(first.data); // identity — not even re-decoded
  });

  it('keeps a degenerate aspect ratio at least 1px tall (no zero-size collapse)', async () => {
    // 9000×2 scaled to a 2000px edge would round the short side to 0.44px;
    // the resizer must clamp to 1, not produce an undecodable 2000×0 image.
    const png = await solidPng(9000, 2);
    const result = await compressImageForModel(png, 'image/png');
    expect(result.changed).toBe(true);
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1);
    expect(sniffImageDimensions(result.data)).toEqual({ width: 2000, height: 1 });
  });
});

// ── telemetry ────────────────────────────────────────────────────────

interface CapturedEvent {
  readonly event: string;
  readonly props: Readonly<Record<string, unknown>>;
}

function captureTelemetry(): { client: ImageCompressionTelemetryClient; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    client: { track: (event, props) => events.push({ event, props: props ?? {} }) },
    events,
  };
}

describe('compressImageForModel — telemetry', () => {
  it('reports a compressed image with sizes, formats, and duration', async () => {
    const { client, events } = captureTelemetry();
    const png = await solidPng(2100, 1050);
    const result = await compressImageForModel(png, 'image/png', {
      telemetry: { client, source: 'read_media' },
    });
    expect(result.changed).toBe(true);

    expect(events).toHaveLength(1);
    const { event, props } = events[0]!;
    expect(event).toBe('image_compress');
    expect(props['source']).toBe('read_media');
    expect(props['outcome']).toBe('compressed');
    expect(props['input_mime']).toBe('image/png');
    expect(props['output_mime']).toBe(result.mimeType);
    expect(props['original_bytes']).toBe(png.length);
    expect(props['final_bytes']).toBe(result.finalByteLength);
    expect(props['original_width']).toBe(2100);
    expect(props['original_height']).toBe(1050);
    expect(props['final_width']).toBe(2000);
    expect(props['final_height']).toBe(1000);
    expect(props['exif_transposed']).toBe(false);
    expect(typeof props['duration_ms']).toBe('number');
  });

  it('reports the fast path as passthrough_fast', async () => {
    const { client, events } = captureTelemetry();
    await compressImageForModel(await solidPng(64, 64), 'image/png', {
      telemetry: { client, source: 'tui_paste' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.props['outcome']).toBe('passthrough_fast');
    expect(events[0]!.props['source']).toBe('tui_paste');
  });

  it('reports decode guards as passthrough_guard', async () => {
    // Decompression-bomb header: 30000×30000 with no pixel data.
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(30000, 16);
    header.writeUInt32BE(30000, 20);

    const bomb = captureTelemetry();
    await compressImageForModel(new Uint8Array(header), 'image/png', {
      telemetry: { client: bomb.client, source: 'mcp_tool_result' },
    });
    expect(bomb.events[0]!.props['outcome']).toBe('passthrough_guard');

    const byteCap = captureTelemetry();
    await compressImageForModel(await solidPng(2100, 100), 'image/png', {
      maxDecodeBytes: 64,
      telemetry: { client: byteCap.client, source: 'mcp_tool_result' },
    });
    expect(byteCap.events[0]!.props['outcome']).toBe('passthrough_guard');
  });

  it('reports non-recodable formats and empty input as passthrough_unsupported', async () => {
    const gif = captureTelemetry();
    await compressImageForModel(
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]),
      'image/gif',
      { telemetry: { client: gif.client, source: 'mcp_tool_result' } },
    );
    expect(gif.events[0]!.props['outcome']).toBe('passthrough_unsupported');

    const empty = captureTelemetry();
    await compressImageForModel(new Uint8Array(0), 'image/png', {
      telemetry: { client: empty.client, source: 'mcp_tool_result' },
    });
    expect(empty.events[0]!.props['outcome']).toBe('passthrough_unsupported');
  });

  it('reports undecodable bytes as passthrough_error', async () => {
    // A tiny corrupt blob would pass through on the fast path (unknown dims,
    // small bytes) without ever decoding; to reach the decoder the header
    // must claim an over-cap size. 4000×4000 forces a decode of garbage.
    const { client, events } = captureTelemetry();
    const corrupt = Buffer.alloc(32);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(corrupt, 0);
    corrupt.writeUInt32BE(13, 8);
    corrupt.write('IHDR', 12, 'latin1');
    corrupt.writeUInt32BE(4000, 16);
    corrupt.writeUInt32BE(4000, 20);
    await compressImageForModel(new Uint8Array(corrupt), 'image/png', {
      telemetry: { client, source: 'prompt_inline' },
    });
    expect(events[0]!.props['outcome']).toBe('passthrough_error');
  });

  it('marks EXIF-transposed inputs', async () => {
    const { client, events } = captureTelemetry();
    const jpeg = withExifOrientation(await solidJpeg(120, 80), 6);
    await compressImageForModel(jpeg, 'image/jpeg', {
      maxEdge: 64,
      telemetry: { client, source: 'read_media' },
    });
    expect(events[0]!.props['outcome']).toBe('compressed');
    expect(events[0]!.props['exif_transposed']).toBe(true);
  });

  it('reports the base64 early size-skip as passthrough_guard', async () => {
    const { client, events } = captureTelemetry();
    const base64 = Buffer.from(await solidPng(2100, 100)).toString('base64');
    await compressBase64ForModel(base64, 'image/png', {
      maxDecodeBytes: 64,
      telemetry: { client, source: 'prompt_file' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.props['outcome']).toBe('passthrough_guard');
    expect(events[0]!.props['source']).toBe('prompt_file');
  });

  it('threads telemetry through compressImageContentParts', async () => {
    const { client, events } = captureTelemetry();
    const big = await solidPng(2100, 1050);
    const url = `data:image/png;base64,${Buffer.from(big).toString('base64')}`;
    await compressImageContentParts([{ type: 'image_url', imageUrl: { url } }], {
      telemetry: { client, source: 'mcp_tool_result' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('image_compress');
    expect(events[0]!.props['outcome']).toBe('compressed');
    expect(events[0]!.props['source']).toBe('mcp_tool_result');
  });

  it('never lets a throwing telemetry client break compression', async () => {
    const throwing: ImageCompressionTelemetryClient = {
      track: () => {
        throw new Error('sink down');
      },
    };
    const png = await solidPng(2100, 1050);
    const result = await compressImageForModel(png, 'image/png', {
      telemetry: { client: throwing, source: 'read_media' },
    });
    expect(result.changed).toBe(true); // compression outcome unaffected
  });
});

describe('cropImageForModel — telemetry', () => {
  it('reports a successful crop with the region share of the original', async () => {
    const { client, events } = captureTelemetry();
    const png = await solidPng(1000, 500);
    const outcome = await cropImageForModel(
      png,
      'image/png',
      { x: 0, y: 0, width: 500, height: 250 },
      { telemetry: { client, source: 'read_media' } },
    );
    expect(outcome.ok).toBe(true);

    expect(events).toHaveLength(1);
    const { event, props } = events[0]!;
    expect(event).toBe('image_crop');
    expect(props['source']).toBe('read_media');
    expect(props['ok']).toBe(true);
    expect(props['resized']).toBe(false);
    expect(props['original_width']).toBe(1000);
    expect(props['original_height']).toBe(500);
    // 500×250 of 1000×500 → a quarter of the pixels.
    expect(props['region_area_ratio']).toBeCloseTo(0.25, 5);
    expect(typeof props['duration_ms']).toBe('number');
    expect(typeof props['final_bytes']).toBe('number');
  });

  it('classifies failures by kind', async () => {
    const oob = captureTelemetry();
    await cropImageForModel(
      await solidPng(100, 100),
      'image/png',
      { x: 200, y: 0, width: 10, height: 10 },
      { telemetry: { client: oob.client, source: 'read_media' } },
    );
    expect(oob.events[0]!.props['ok']).toBe(false);
    expect(oob.events[0]!.props['error_kind']).toBe('out_of_bounds');

    const format = captureTelemetry();
    await cropImageForModel(
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]),
      'image/gif',
      { x: 0, y: 0, width: 1, height: 1 },
      { telemetry: { client: format.client, source: 'read_media' } },
    );
    expect(format.events[0]!.props['error_kind']).toBe('unsupported_format');

    const budget = captureTelemetry();
    await cropImageForModel(
      await noisePng(400, 400),
      'image/png',
      { x: 0, y: 0, width: 400, height: 400 },
      { skipResize: true, byteBudget: 8 * 1024, telemetry: { client: budget.client, source: 'read_media' } },
    );
    expect(budget.events[0]!.props['error_kind']).toBe('budget');
  });
});

describe('image-compress config resolver seam', () => {
  // The resolvers read process-global "configured" overrides pushed by the
  // media-domain image-config bridge. Clear them after every test so this
  // module-global state never leaks into the compression cases above.
  afterEach(() => {
    setConfiguredMaxImageEdgePx(undefined);
    setConfiguredReadImageByteBudget(undefined);
  });

  it('resolves the longest-edge ceiling from config, falling back to the built-in', () => {
    expect(resolveMaxImageEdgePx()).toBe(MAX_IMAGE_EDGE_PX);
    setConfiguredMaxImageEdgePx(1500);
    expect(resolveMaxImageEdgePx()).toBe(1500);
    setConfiguredMaxImageEdgePx(undefined);
    expect(resolveMaxImageEdgePx()).toBe(MAX_IMAGE_EDGE_PX);
  });

  it('ignores non-positive-int configured ceilings', () => {
    setConfiguredMaxImageEdgePx(0);
    expect(resolveMaxImageEdgePx()).toBe(MAX_IMAGE_EDGE_PX);
    setConfiguredMaxImageEdgePx(-5);
    expect(resolveMaxImageEdgePx()).toBe(MAX_IMAGE_EDGE_PX);
    setConfiguredMaxImageEdgePx(1.5);
    expect(resolveMaxImageEdgePx()).toBe(MAX_IMAGE_EDGE_PX);
  });

  it('resolves the read-image byte budget from config, falling back to the built-in', () => {
    expect(resolveReadImageByteBudget()).toBe(READ_IMAGE_BYTE_BUDGET);
    setConfiguredReadImageByteBudget(128 * 1024);
    expect(resolveReadImageByteBudget()).toBe(128 * 1024);
    setConfiguredReadImageByteBudget(undefined);
    expect(resolveReadImageByteBudget()).toBe(READ_IMAGE_BYTE_BUDGET);
  });
});
