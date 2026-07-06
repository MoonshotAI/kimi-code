/**
 * Shrink oversized images before they reach the model.
 *
 * A multimodal request carries each image as a base64 data URL; an unbounded
 * screenshot or photo wastes context tokens and can blow past the provider's
 * per-image byte ceiling. This module downsamples and re-encodes such images
 * so they fit a pixel + byte budget, while leaving already-small images
 * untouched — the common case is a fast, codec-free pass-through.
 *
 * Design notes:
 *  - Pure JS (jimp), imported lazily so the codec is only paid for when an
 *    image actually needs work; startup and the fast path stay cheap.
 *  - Best effort: any decode/encode failure returns the original bytes
 *    unchanged (`changed: false`), so a compression problem never blocks a
 *    prompt. Callers simply send the original instead.
 *  - Only PNG and JPEG are re-encoded. GIF is passed through to preserve
 *    animation; WebP is passed through because the default jimp build ships no
 *    WebP codec. Unknown formats are passed through.
 *  - Compression must never be silent to the model: results carry the
 *    original dimensions, {@link buildImageCompressionCaption} renders the
 *    shared "what was compressed, where is the original" note every ingestion
 *    point can place next to the image, and {@link cropImageForModel} lets a
 *    caller read a region of the original back at full fidelity. In user
 *    prompts the context layer later reroutes that note through the hidden
 *    system-reminder injection via {@link extractImageCompressionCaptions},
 *    so its raw `<system>` markup never renders in the UI.
 */

import type { ContentPart } from '@moonshot-ai/kosong';

import { sniffImageDimensions } from './file-type';

/** Longest-edge ceiling (px). Larger images are scaled down to fit. */
export const MAX_IMAGE_EDGE_PX = 2000;

/**
 * Raw-byte budget for a single image. base64 inflates bytes by ~4/3, so a
 * 3.75 MB raw payload stays under a 5 MB encoded ceiling. Tune to the active
 * provider's per-image limit.
 */
export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

/** Progressively lower JPEG quality until the payload fits the byte budget. */
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

/** Last-ditch longest edge when the budget cannot be met at MAX_IMAGE_EDGE_PX. */
const FALLBACK_EDGE_PX = 1000;

/**
 * Pixel-count ceiling above which we skip compression entirely. A tiny-byte,
 * huge-dimension image (e.g. a solid 30000×30000 PNG) would otherwise be fully
 * decoded into a multi-gigabyte bitmap by Jimp before any resize — a
 * decompression-bomb OOM vector, since the byte budget alone never catches it.
 * The header sniff gives us the dimensions without decoding, so we gate on them
 * first. Set well above any legitimate photo/screenshot/scan (~100 MP); larger
 * images pass through uncompressed, exactly as they did before compression
 * existed.
 */
const MAX_DECODE_PIXELS = 100_000_000;

/**
 * Raw-byte ceiling above which compression is skipped rather than decoded. The
 * byte budget bounds the *output*, but the compressor still has to load the
 * *input* first: a huge base64 payload (e.g. an oversized or invalid image from
 * an MCP tool) would be `Buffer.from`-decoded — and possibly handed to Jimp —
 * before any downstream cap (like the 10 MB MCP per-part limit) can drop it.
 * This bounds that input allocation. Set well above legitimate
 * screenshots/photos; larger images pass through uncompressed.
 */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/** Formats we can both decode and re-encode with the default jimp build. */
const RECODABLE_MIME = new Set(['image/png', 'image/jpeg']);

export interface CompressImageOptions {
  /** Override the longest-edge ceiling (px). */
  readonly maxEdge?: number;
  /** Override the raw-byte budget. */
  readonly byteBudget?: number;
  /** Override the raw-byte ceiling above which compression is skipped. */
  readonly maxDecodeBytes?: number;
}

export interface CompressImageResult {
  /** Bytes to send: the re-encoded image, or the original when unchanged. */
  readonly data: Uint8Array;
  /** MIME of `data`. May differ from the input (e.g. png → jpeg). */
  readonly mimeType: string;
  /** Pixel width of `data`; falls back to the input size when unknown. */
  readonly width: number;
  /** Pixel height of `data`; falls back to the input size when unknown. */
  readonly height: number;
  /** Pixel width of the input image; 0 when it cannot be sniffed. */
  readonly originalWidth: number;
  /** Pixel height of the input image; 0 when it cannot be sniffed. */
  readonly originalHeight: number;
  /** True only when `data` differs from the input bytes. */
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Downsample/re-encode `bytes` to fit the pixel + byte budget.
 *
 * Never throws: on any failure (unsupported format, decode error, a result
 * that would be larger than the input) the original bytes are returned with
 * `changed: false`.
 */
export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
  const normalizedMime = normalizeMime(mimeType);
  const dims = sniffImageDimensions(bytes);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });

  if (bytes.length === 0) return passthrough();
  // Only re-encode formats the codec handles; everything else passes through.
  if (!RECODABLE_MIME.has(normalizedMime)) return passthrough();

  // Fast path: already within both budgets — no codec load, no allocation.
  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) return passthrough();

  // Decompression-bomb guard: refuse to decode absurd pixel counts. The sniff
  // above gave us the dimensions without decoding, so this costs nothing.
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return passthrough();
  // Refuse to decode very large byte payloads (e.g. a huge or invalid image
  // from an MCP tool) that would be loaded just to be dropped downstream.
  if (bytes.length > maxDecodeBytes) return passthrough();

  try {
    const { Jimp } = await import('jimp');
    const image = await Jimp.fromBuffer(Buffer.from(bytes));
    const sourceIsPng = normalizedMime === 'image/png';

    // Scale so the longest edge fits maxEdge (never enlarges).
    fitWithinEdge(image, maxEdge);

    const encoded = await encodeWithinBudget(image, {
      sourceIsPng,
      byteBudget,
      fallbackEdge: FALLBACK_EDGE_PX,
    });

    // Keep the result when it actually helps: fewer bytes, or fewer pixels
    // (a smaller image costs fewer vision tokens even if the byte count is
    // flat, as with near-solid graphics). Otherwise the re-encode bought us
    // nothing — send the original.
    const originalPixels = (dims?.width ?? 0) * (dims?.height ?? 0);
    const finalPixels = encoded.width * encoded.height;
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = originalPixels > 0 && finalPixels < originalPixels;
    if (!shrankBytes && !shrankPixels) return passthrough();

    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: dims?.width ?? 0,
      originalHeight: dims?.height ?? 0,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch {
    // Decode/encode failure — keep the original bytes.
    return passthrough();
  }
}

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  /** Pixel width of the (possibly re-encoded) payload; 0 when unknown. */
  readonly width: number;
  /** Pixel height of the (possibly re-encoded) payload; 0 when unknown. */
  readonly height: number;
  /** Pixel width of the input image; 0 when it cannot be sniffed. */
  readonly originalWidth: number;
  /** Pixel height of the input image; 0 when it cannot be sniffed. */
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Convenience wrapper for call sites that already hold base64 (MCP results,
 * data URLs). Decodes, compresses, and re-encodes to base64. Best effort:
 * returns the original base64 unchanged on any failure.
 */
export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  // Skip very large payloads before allocating: base64 decodes to ~3/4 its
  // length, so a payload whose decoded size would exceed the cap is passed
  // through without the Buffer.from allocation (and without touching Jimp).
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxDecodeBytes) {
    return {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: approxBytes,
      finalByteLength: approxBytes,
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return {
      base64,
      mimeType,
      width: 0,
      height: 0,
      originalWidth: 0,
      originalHeight: 0,
      changed: false,
      originalByteLength: 0,
      finalByteLength: 0,
    };
  }
  const result = await compressImageForModel(bytes, mimeType, options);
  if (!result.changed) {
    return {
      base64,
      mimeType,
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      changed: false,
      originalByteLength: result.originalByteLength,
      finalByteLength: result.finalByteLength,
    };
  }
  return {
    base64: Buffer.from(result.data).toString('base64'),
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
    originalWidth: result.originalWidth,
    originalHeight: result.originalHeight,
    changed: true,
    originalByteLength: result.originalByteLength,
    finalByteLength: result.finalByteLength,
  };
}

/**
 * Compress any inline base64 image parts in a content-part list — the single
 * helper used by the prompt-ingestion chokepoint (every client's images) and
 * the MCP tool-result path. Image parts whose URL is not a `data:` URL (e.g. a
 * remote http(s) image) are passed through, as are non-image parts. Best
 * effort: a part that fails to compress is left unchanged.
 *
 * With `annotate` set, every image that was actually re-encoded gains a
 * {@link buildImageCompressionCaption} text part immediately before it, so the
 * model knows it is looking at a downsampled copy. `annotate.persistOriginal`
 * additionally saves the pre-compression bytes and puts the returned path in
 * the caption so the model can read the original back; persistence failures
 * degrade to a caption without a path.
 */
export async function compressImageContentParts(
  parts: readonly ContentPart[],
  options: CompressImageOptions & { readonly annotate?: CompressAnnotateOptions } = {},
): Promise<ContentPart[]> {
  const { annotate, ...compressOptions } = options;
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed !== null) {
        const result = await compressBase64ForModel(parsed.base64, parsed.mimeType, compressOptions);
        if (result.changed) {
          if (annotate !== undefined) {
            let originalPath: string | null = null;
            if (annotate.persistOriginal !== undefined) {
              try {
                originalPath = await annotate.persistOriginal(
                  Buffer.from(parsed.base64, 'base64'),
                  parsed.mimeType,
                );
              } catch {
                originalPath = null;
              }
            }
            out.push({
              type: 'text',
              text: buildImageCompressionCaption({
                original: {
                  width: result.originalWidth,
                  height: result.originalHeight,
                  byteLength: result.originalByteLength,
                  mimeType: parsed.mimeType,
                },
                final: {
                  width: result.width,
                  height: result.height,
                  byteLength: result.finalByteLength,
                  mimeType: result.mimeType,
                },
                originalPath,
              }),
            });
          }
          out.push({
            type: 'image_url',
            imageUrl: { ...part.imageUrl, url: `data:${result.mimeType};base64,${result.base64}` },
          });
          continue;
        }
      }
    }
    out.push(part);
  }
  return out;
}

export interface CompressAnnotateOptions {
  /**
   * Persist the pre-compression original bytes somewhere the model can read
   * them back; return the absolute path, or null when persistence failed.
   */
  readonly persistOriginal?: (bytes: Uint8Array, mimeType: string) => Promise<string | null>;
}

// ── crop ─────────────────────────────────────────────────────────────

/** Crop rectangle in ORIGINAL-image pixel coordinates. */
export interface ImageCropRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropImageOptions extends CompressImageOptions {
  /**
   * Keep the crop at native resolution (no edge-fit downscale). The byte
   * budget still applies: a crop that cannot be encoded within it fails
   * explicitly instead of being silently degraded.
   */
  readonly skipResize?: boolean;
}

export interface CropImageSuccess {
  readonly ok: true;
  readonly data: Uint8Array;
  readonly mimeType: string;
  /** Pixel size of the encoded crop actually produced. */
  readonly width: number;
  readonly height: number;
  /** Pixel size of the source image the region was cut from. */
  readonly originalWidth: number;
  readonly originalHeight: number;
  /** The region actually applied, after clamping to the image bounds. */
  readonly region: ImageCropRegion;
  /** True when the crop was downscaled to fit the pixel/byte budget. */
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export interface CropImageFailure {
  readonly ok: false;
  /** Human/model-readable reason, safe to surface as a tool error. */
  readonly error: string;
}

export type CropImageOutcome = CropImageSuccess | CropImageFailure;

/**
 * Cut `region` out of `bytes` and encode it for the model.
 *
 * Unlike {@link compressImageForModel}, cropping is an explicit request: it
 * never falls back to the full image. Anything that prevents an accurate crop
 * (unsupported format, undecodable bytes, a region outside the image, a
 * skipResize result over the byte budget) returns `ok: false` with a reason
 * the caller can hand straight back to the model.
 *
 * The default path fits the crop to the usual pixel/byte budgets; a crop no
 * larger than the edge cap is therefore delivered at native resolution.
 */
export async function cropImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  region: ImageCropRegion,
  options: CropImageOptions = {},
): Promise<CropImageOutcome> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
  const normalizedMime = normalizeMime(mimeType);

  if (bytes.length === 0) {
    return { ok: false, error: 'The image is empty.' };
  }
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return {
      ok: false,
      error: `Cropping is only supported for PNG and JPEG images; got ${mimeType}.`,
    };
  }
  // NaN slips past every </>= comparison in the bounds guard below, so gate
  // on finiteness explicitly rather than surfacing a codec-internal error.
  if (
    ![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value))
  ) {
    return {
      ok: false,
      error:
        `Region coordinates must be finite numbers; got x=${String(region.x)}, ` +
        `y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    };
  }
  const dims = sniffImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return {
      ok: false,
      error: `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    };
  }
  if (bytes.length > maxDecodeBytes) {
    return { ok: false, error: 'The image is too large to decode for cropping.' };
  }

  try {
    const { Jimp } = await import('jimp');
    const image = await Jimp.fromBuffer(Buffer.from(bytes));
    const originalWidth = image.width;
    const originalHeight = image.height;

    const x = Math.floor(region.x);
    const y = Math.floor(region.y);
    if (x < 0 || y < 0 || x >= originalWidth || y >= originalHeight || region.width < 1 || region.height < 1) {
      return {
        ok: false,
        error:
          `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, ` +
          `height=${String(region.height)}) lies outside the ${String(originalWidth)}x${String(originalHeight)} image.`,
      };
    }
    const w = Math.min(Math.floor(region.width), originalWidth - x);
    const h = Math.min(Math.floor(region.height), originalHeight - y);
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    image.crop({ x, y, w, h });
    const sourceIsPng = normalizedMime === 'image/png';

    if (options.skipResize === true) {
      // Native resolution requested: encode once, favoring fidelity (lossless
      // PNG, or high-quality JPEG), and refuse rather than degrade when the
      // result cannot fit the byte budget.
      const buffer = sourceIsPng
        ? await image.getBuffer('image/png', { deflateLevel: 9 })
        : await image.getBuffer('image/jpeg', { quality: 90 });
      if (buffer.length > byteBudget) {
        return {
          ok: false,
          error:
            `The cropped region encodes to ${String(buffer.length)} bytes ` +
            `(${formatByteSize(buffer.length)}), over the ${String(byteBudget)}-byte ` +
            `(${formatByteSize(byteBudget)}) per-image limit. ` +
            'Choose a smaller region, or allow downscaling.',
        };
      }
      return {
        ok: true,
        data: new Uint8Array(buffer),
        mimeType: sourceIsPng ? 'image/png' : 'image/jpeg',
        width: image.width,
        height: image.height,
        originalWidth,
        originalHeight,
        region: applied,
        resized: false,
        originalByteLength: bytes.length,
        finalByteLength: buffer.length,
      };
    }

    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, {
      sourceIsPng,
      byteBudget,
      fallbackEdge: FALLBACK_EDGE_PX,
    });
    return {
      ok: true,
      data: new Uint8Array(encoded.data),
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth,
      originalHeight,
      region: applied,
      resized: encoded.width !== w || encoded.height !== h,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── compression caption ──────────────────────────────────────────────

export interface ImageVariantDescription {
  /** Pixel size; pass 0 when unknown to omit the dimensions. */
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  /** Absolute path where the pre-compression original can be read back. */
  readonly originalPath?: string | null;
}

/**
 * Render the shared `<system>` note placed next to a compressed image so the
 * model knows it is looking at a downsampled copy: what the original was, what
 * was actually sent, and — when the original is on disk — where to read it
 * back (via ReadMediaFile `region`) for full-fidelity detail.
 *
 * Two channels consume this note differently:
 *  - Tool results (MCP images) keep it inline — `<system>` status text inside
 *    tool output is the established convention there.
 *  - User prompts must not render raw `<system>` markup in the UI, so the
 *    context layer detects the caption via
 *    {@link extractImageCompressionCaptions} and reroutes it through the
 *    built-in system-reminder injection (hidden by its `injection` origin).
 */
export function buildImageCompressionCaption(input: ImageCompressionCaptionInput): string {
  const sentences = [
    `Image compressed to fit model limits: original ${describeImageVariant(input.original)} -> ` +
      `sent ${describeImageVariant(input.final)}.`,
    'Fine detail may be lost.',
  ];
  if (typeof input.originalPath === 'string' && input.originalPath.length > 0) {
    sentences.push(
      `The uncompressed original is saved at "${input.originalPath}"; if you need fine detail ` +
        '(e.g. small text), call ReadMediaFile on that path with the region parameter ' +
        '(original-pixel coordinates) to view a crop at full fidelity.',
    );
  } else {
    sentences.push('The uncompressed original was not preserved.');
  }
  return `<system>${sentences.join(' ')}</system>`;
}

/**
 * Fixed opening every {@link buildImageCompressionCaption} note starts with —
 * the anchor {@link extractImageCompressionCaptions} matches on. Keep the two
 * in sync.
 */
const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

/**
 * A full caption embedded in arbitrary text. The body is sentences plus a
 * quoted file path and never contains `</system>`, so the non-greedy scan to
 * the closing tag is exact.
 */
const CAPTION_PATTERN = /<system>(Image compressed to fit model limits:[\s\S]*?)<\/system>/g;

export interface ImageCompressionCaptionExtraction {
  /** Caption bodies found, in order, without the `<system>` wrapper. */
  readonly captions: readonly string[];
  /** The input text with every caption removed. */
  readonly text: string;
}

/**
 * Find every {@link buildImageCompressionCaption} note embedded in `text` and
 * return the unwrapped caption bodies plus the text without them. Prompt
 * ingestion (server upload/base64 route, TUI paste, ACP) places the caption
 * inline next to the image — sometimes merged into an adjacent text segment —
 * and the context layer uses this to reroute the note through the built-in
 * system-reminder injection instead of leaving raw `<system>` markup in the
 * user-visible message.
 */
export function extractImageCompressionCaptions(text: string): ImageCompressionCaptionExtraction {
  if (!text.includes(CAPTION_OPENING)) return { captions: [], text };
  const captions: string[] = [];
  const remainder = text.replace(CAPTION_PATTERN, (_match, body: string) => {
    captions.push(body);
    return '';
  });
  return { captions, text: remainder };
}

function describeImageVariant(variant: ImageVariantDescription): string {
  const size = `${variant.mimeType} (${formatByteSize(variant.byteLength)})`;
  if (variant.width > 0 && variant.height > 0) {
    return `${String(variant.width)}x${String(variant.height)} ${size}`;
  }
  return size;
}

/** Human-readable byte size: `640 B`, `128 KB`, `3.8 MB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseImageDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

// ── internals ────────────────────────────────────────────────────────

/** The concrete jimp image instance type, derived from the lazily-loaded module. */
type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly sourceIsPng: boolean;
  readonly byteBudget: number;
  readonly fallbackEdge: number;
}

/**
 * Encode `image` (already fitted to the edge ceiling) under the byte budget.
 *
 * Strategy — prefer the source format so a downscaled screenshot stays lossless
 * PNG (preserving text and transparency), and only fall back to lossy JPEG when
 * PNG cannot meet the byte budget:
 *  - PNG source: PNG at the fitted size → a smaller PNG rescale → JPEG ladder.
 *  - JPEG source: JPEG quality ladder → a smaller JPEG rescale.
 *
 * Always returns the smallest buffer it produced, even if no attempt met the
 * budget — the caller still gates on whether it actually helped.
 */
async function encodeWithinBudget(image: JimpImage, opts: EncodeOptions): Promise<EncodedImage> {
  const { sourceIsPng, byteBudget, fallbackEdge } = opts;
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) {
      smallest = candidate;
    }
    return candidate;
  };

  if (sourceIsPng) {
    // Lossless PNG first: best for screenshots/UI (sharp text) and keeps alpha.
    const png = await image.getBuffer('image/png', { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, 'image/png');
    consider(png, 'image/png');

    // Over budget: a smaller PNG before going lossy.
    if (fitWithinEdge(image, fallbackEdge)) {
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 });
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png');
      consider(smallerPng, 'image/png');
    }

    // Last resort: lossy JPEG ladder (drops transparency) to meet the budget.
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
      consider(jpeg, 'image/jpeg');
    }
    return smallest!;
  }

  // JPEG source: quality ladder, then a smaller rescale at the lowest quality.
  for (const quality of JPEG_QUALITY_STEPS) {
    const jpeg = await image.getBuffer('image/jpeg', { quality });
    if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
    consider(jpeg, 'image/jpeg');
  }
  if (fitWithinEdge(image, fallbackEdge)) {
    const jpeg = await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY_STEPS.at(-1) });
    consider(jpeg, 'image/jpeg');
  }

  return smallest!;
}

/**
 * Scale `image` so its longest edge is at most `edge`, preserving aspect
 * ratio. No-op (returns false) when the image already fits.
 */
function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height);
  if (longest <= edge) return false;
  const factor = edge / longest;
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  });
  return true;
}

function normalizeMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}
