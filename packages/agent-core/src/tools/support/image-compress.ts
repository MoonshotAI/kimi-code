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
 *  - Rust native codec (image crate) handles the full decode→resize→encode
 *    pipeline 10–100× faster than pure JS alternatives.
 *  - Best effort: any decode/encode failure returns the original bytes
 *    unchanged (`changed: false`). Callers must verify that this unchanged
 *    result satisfies their delivery limits before forwarding it.
 *  - PNG, JPEG, and (non-animated) WebP are re-encoded; WebP re-encodes
 *    through the PNG/JPEG ladder, so only its decoder wasm ships. GIF and
 *    animated WebP are passed through to preserve animation. Formats outside
 *    the provider-accepted set (see ./image-format-policy) are never
 *    forwarded by the part-level helpers — they are replaced with a text
 *    notice; the byte-level helpers still pass anything they cannot
 *    re-encode through unchanged, so callers must gate on
 *    `isModelAcceptedImageMime` first.
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

import type { TelemetryClient } from '#/telemetry';

import { sniffImageDimensions } from './file-type';
import {
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from './image-format-policy';
import { isAnimatedWebp } from './webp-animated';
import {
  tryNativeCompressImage,
  tryNativeCropImage,
} from '../builtin/native-tools';

/**
 * Built-in longest-edge ceiling (px). Larger images are scaled down to fit.
 * This is the default only: the effective ceiling is resolved per call by
 * {@link resolveMaxImageEdgePx} (explicit option > env > config > this).
 */
export const MAX_IMAGE_EDGE_PX = 2000;

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** The `[image] max_edge_px` value from config.toml; set at core startup. */
let configuredMaxImageEdgePx: number | undefined;

/** Push (or clear, with `undefined`) the config.toml max-pixel-edge ceiling. */
export function setConfiguredMaxImageEdgePx(value: number | undefined): void {
  configuredMaxImageEdgePx = value !== undefined && isPositiveInt(value) ? value : undefined;
}

/**
 * Env var overriding the longest-edge ceiling (px). Read live on every
 * resolution so it applies in any process without wiring; a value that is
 * not a positive integer is ignored.
 */
export const MAX_IMAGE_EDGE_ENV = 'KIMI_IMAGE_MAX_EDGE_PX';

/** The env override for the longest-edge ceiling, or undefined when unset/invalid. */
export function maxImageEdgeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  return positiveIntFromEnv(env, MAX_IMAGE_EDGE_ENV);
}

/**
 * Effective default longest-edge ceiling (px), for calls that pass no
 * explicit `maxEdge`. Precedence: env var > config.toml > built-in
 * {@link MAX_IMAGE_EDGE_PX}. Owned call sites (tools under an Agent, server
 * ingestion under a core) resolve through their `ImageLimits` instance
 * instead, which adds the owner's `[image]` config between the two.
 */
export function resolveMaxImageEdgePx(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return maxImageEdgeFromEnv(env) ?? configuredMaxImageEdgePx ?? MAX_IMAGE_EDGE_PX;
}

function positiveIntFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Raw-byte budget for a single image. base64 inflates bytes by ~4/3, so a
 * 3.75 MB raw payload stays under a 5 MB encoded ceiling. Tune to the active
 * provider's per-image limit.
 */
export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

/**
 * Built-in raw-byte budget for images the model reads for itself
 * (ReadMediaFile's default path). Far below {@link IMAGE_BYTE_BUDGET}: a
 * session that keeps screenshotting and reading images accumulates every one
 * of them in the request body on every turn, so per-image size — not the
 * provider's per-image ceiling — is what keeps the total under the
 * provider's request-size limit. 256 KB keeps a clean 2000px UI screenshot
 * on the lossless fast path while capping dense content at a readable
 * q80/1000px JPEG; fine detail stays reachable through the `region`
 * readback, which deliberately ignores this budget.
 */
export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

/**
 * Env var overriding the read-image byte budget. Read live on every
 * resolution; a value that is not a positive integer is ignored.
 */
export const READ_IMAGE_BYTE_BUDGET_ENV = 'KIMI_IMAGE_READ_BYTE_BUDGET';

/** The `[image] read_byte_budget` value from config.toml; see {@link setConfiguredMaxImageEdgePx}. */
let configuredReadImageByteBudget: number | undefined;

/** Push (or clear, with `undefined`) the config.toml read-image byte budget. */
export function setConfiguredReadImageByteBudget(value: number | undefined): void {
  configuredReadImageByteBudget = value !== undefined && isPositiveInt(value) ? value : undefined;
}

/** The env override for the read-image byte budget, or undefined when unset/invalid. */
export function readImageByteBudgetFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
  return positiveIntFromEnv(env, READ_IMAGE_BYTE_BUDGET_ENV);
}

/**
 * Effective read-image byte budget. Precedence:
 * env var > config.toml > built-in {@link READ_IMAGE_BYTE_BUDGET}.
 * Owned call sites resolve through their `ImageLimits` instance instead.
 */
export function resolveReadImageByteBudget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return readImageByteBudgetFromEnv(env) ?? configuredReadImageByteBudget ?? READ_IMAGE_BYTE_BUDGET;
}

/** Progressively lower JPEG quality until the payload fits the byte budget. */
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

/**
 * Longest-edge step-downs tried when the budget cannot be met at the fitted
 * size. With the built-in 2000px ceiling the first step is a no-op; it
 * matters when a larger ceiling is configured (config/env/option). The
 * sub-1000px tail exists for small (read-scale) budgets: JPEG bytes shrink
 * roughly linearly with pixel count, so stepping down to 256px lets even
 * entropy-upper-bound content (noise, photos) land within any budget of a
 * few tens of KB instead of stalling at the q20@1000px floor.
 */
const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

/**
 * PNG rescales stop at this edge; below it the ladder goes lossy instead.
 * For text-bearing screenshots a q80 JPEG at 1000px reads better than a
 * lossless PNG at 512px — resolution beats losslessness once both are
 * degraded — so sub-floor edges are only ever tried with the JPEG ladder.
 */
const PNG_RESCALE_FLOOR_PX = 1000;

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
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

/** Formats we can decode and re-encode. WebP decodes via the bundled wasm
 * codec and re-encodes through the PNG/JPEG ladder (animated WebP is gated
 * to a passthrough before decoding). */
const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface CompressImageOptions {
  /**
   * Override the longest-edge ceiling (px). When omitted, owned call sites
   * pass their {@link ImageLimits.maxEdgePx}; ownerless ones fall back to
   * {@link resolveMaxImageEdgePx} (env var, then built-in).
   */
  readonly maxEdge?: number;
  /** Override the raw-byte budget. */
  readonly byteBudget?: number;
  /** Override the raw-byte ceiling above which compression is skipped. */
  readonly maxDecodeBytes?: number;
  /**
   * Report an `image_compress` event per compression call (and an
   * `image_crop` event per {@link cropImageForModel} call). Absent → silent.
   */
  readonly telemetry?: ImageCompressionTelemetry;
}

/** Wiring for the optional compression telemetry events. */
export interface ImageCompressionTelemetry {
  readonly client: TelemetryClient;
  /** Where the image entered the pipeline, e.g. 'read_media', 'tui_paste'. */
  readonly source: string;
}

/**
 * How a compression call ended, as reported in the `image_compress` event.
 * Every `passthrough_*` variant returns the input bytes unchanged: `fast` is
 * the within-budgets hot path, `guard` a decode-safety refusal (pixel bomb or
 * byte cap), `unsupported` a format the codec cannot re-encode (or empty
 * input), `unhelpful` a re-encode that saved neither bytes nor pixels, and
 * `error` a decode/encode failure.
 */
type CompressOutcome =
  | 'compressed'
  | 'passthrough_fast'
  | 'passthrough_guard'
  | 'passthrough_unsupported'
  | 'passthrough_unhelpful'
  | 'passthrough_error';

export interface CompressImageResult {
  /** Bytes to send: the re-encoded image, or the original when unchanged. */
  readonly data: Uint8Array;
  /** MIME of `data`. May differ from the input (e.g. png → jpeg). */
  readonly mimeType: string;
  /** Pixel width of `data`; falls back to the input size when unknown. */
  readonly width: number;
  /** Pixel height of `data`; falls back to the input size when unknown. */
  readonly height: number;
  /**
   * Pixel width of the input image, in display space (EXIF orientation
   * applied): the decoded width when re-encoded, the header sniff on
   * passthrough (0 when it cannot be determined).
   */
  readonly originalWidth: number;
  /** Pixel height of the input image; see {@link originalWidth}. */
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
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
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
  const finish = (outcome: CompressOutcome, result: CompressImageResult): CompressImageResult => {
    reportCompressEvent(options.telemetry, {
      outcome,
      startedAt,
      inputMime: normalizedMime,
      exifTransposed: dims?.transposed === true,
      result,
    });
    return result;
  };

  if (bytes.length === 0) return finish('passthrough_unsupported', passthrough());
  // Only re-encode formats the codec handles; everything else passes through.
  if (!RECODABLE_MIME.has(normalizedMime)) return finish('passthrough_unsupported', passthrough());
  // Animated WebP would be flattened to one frame by decoding — pass it
  // through whole, the same reason GIF is never re-encoded.
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return finish('passthrough_unsupported', passthrough());
  }

  // Fast path: already within both budgets — no codec load, no allocation.
  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) {
    return finish('passthrough_fast', passthrough());
  }

  // Decompression-bomb guard: refuse to decode absurd pixel counts. The sniff
  // above gave us the dimensions without decoding, so this costs nothing.
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return finish('passthrough_guard', passthrough());
  }
  // Refuse to decode very large byte payloads (e.g. a huge or invalid image
  // from an MCP tool) that would be loaded just to be dropped downstream.
  if (bytes.length > maxDecodeBytes) return finish('passthrough_guard', passthrough());

  // Try the Rust native codec first (PNG/JPEG/WebP). It is 10–100× faster
  // than jimp and handles the whole decode→resize→encode pipeline.
  // EXIF-rotated JPEGs are deferred to jimp: the Rust image crate does not
  // auto-apply EXIF orientation, so dimension reporting would be off.
  if (dims?.transposed !== true) {
    const nativeResult = await tryNativeCompressImage(bytes, normalizedMime, {
      maxEdge,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
      jpegQualitySteps: JPEG_QUALITY_STEPS,
    });
    if (nativeResult !== undefined) {
      if (!nativeResult.changed) return finish('passthrough_unhelpful', passthrough());
      return finish('compressed', {
        data: nativeResult.data,
        mimeType: nativeResult.mimeType,
        width: nativeResult.width,
        height: nativeResult.height,
        originalWidth: nativeResult.originalWidth,
        originalHeight: nativeResult.originalHeight,
        changed: true,
        originalByteLength: bytes.length,
        finalByteLength: nativeResult.finalByteLength,
      });
    }
  }

  // Native unavailable — passthrough the original image.
  return finish('passthrough_unhelpful', passthrough());
}

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  /** Pixel width of the (possibly re-encoded) payload; 0 when unknown. */
  readonly width: number;
  /** Pixel height of the (possibly re-encoded) payload; 0 when unknown. */
  readonly height: number;
  /**
   * Pixel width of the input image, in display space (EXIF orientation
   * applied): the decoded width when re-encoded, the header sniff on
   * passthrough (0 when it cannot be determined).
   */
  readonly originalWidth: number;
  /** Pixel height of the input image; see {@link originalWidth}. */
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Convenience wrapper for call sites that already hold base64 (MCP results,
 * data URLs). Decodes, compresses, and re-encodes to base64. Best effort:
 * returns the original base64 unchanged on any failure — including formats it
 * cannot re-encode, so callers must refuse MIME types outside the
 * provider-accepted set (`isModelAcceptedImageMime`) before building an
 * image part from the result.
 */
export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
  // Skip very large payloads before allocating: base64 decodes to ~3/4 its
  // length, so a payload whose decoded size would exceed the cap is passed
  // through without the Buffer.from allocation (and without touching Jimp).
  const startedAt = Date.now();
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > maxDecodeBytes) {
    const result: CompressBase64Result = {
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
    reportCompressEvent(options.telemetry, {
      outcome: 'passthrough_guard',
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      exifTransposed: false,
      result,
    });
    return result;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    const result: CompressBase64Result = {
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
    reportCompressEvent(options.telemetry, {
      outcome: 'passthrough_error',
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      exifTransposed: false,
      result,
    });
    return result;
  }
  // The event for this call is emitted inside compressImageForModel.
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

export interface CompressedContentParts {
  /** The input parts with oversized inline images re-encoded in place. */
  readonly parts: ContentPart[];
  /**
   * One {@link buildImageCompressionCaption} note per re-encoded image, in
   * encounter order, when `annotate` is set. Returned as data — never
   * inserted into `parts` — so the caller picks the channel (the MCP path
   * joins them into the tool result's `note`) and quoted caption text in
   * the tool's own output can never be mistaken for a generated one.
   */
  readonly captions: readonly string[];
}

/**
 * Enforce the provider-accepted image format set (see ./image-format-policy)
 * on a content-part list. Inline `data:` image parts whose MIME is outside
 * the accepted set are dropped and replaced with a text notice, so one
 * unsupported image cannot poison the session history. Accepted images are
 * forwarded only as the byte-exact canonical data URL: an alias
 * (`image/jpg`), case/whitespace variants, or MIME parameters
 * (`image/jpeg;charset=utf-8`) all rebuild to the bare canonical form,
 * because strict provider whitelists exact-match the full header. Remote
 * (non-data) image URLs and non-image parts pass through — a URL carries no
 * bytes to inspect.
 *
 * The BYTES are authoritative, not the declared MIME: the header of each
 * inline image is sniffed, and a mismatch (e.g. AVIF bytes an MCP image
 * search tool labels `image/png`) is gated on what the image IS — the
 * provider decodes bytes, not labels. When the sniffer doesn't recognize
 * the bytes (corrupt image, exotic container), the declared MIME stands
 * and the 400-recovery path remains the backstop.
 *
 * This is the format gate shared by every ingestion point; run it BEFORE
 * compression so unsupported bytes are never decoded.
 */
export function gateImageFormatParts(parts: readonly ContentPart[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed === null) {
        // A `data:` URL that failed to parse (missing `;base64,` separator,
        // empty MIME, …) is guaranteed to fail at the provider — Anthropic
        // throws on it, OpenAI-compat servers 400. Drop it for a notice at
        // ingestion instead of leaving it to poison the session and trigger
        // the media-stripped resend on every later turn.
        if (isDataUrl(part.imageUrl.url)) {
          out.push({ type: 'text', text: buildMalformedImageNotice(part.imageUrl.url) });
          continue;
        }
        // Remote image URL (no bytes to sniff): reject when its path
        // extension names a format providers reject (e.g. a search-tool
        // link ending in `.avif`) — the notice keeps the URL so the model
        // can still fetch and convert the image. Extensionless / unknown
        // URLs pass through to the provider — and to the 400 recovery.
        const extMime = unsupportedImageMimeFromUrl(part.imageUrl.url);
        if (extMime !== null) {
          out.push({
            type: 'text',
            text: buildUnsupportedImageNotice(extMime, part.imageUrl.url),
          });
          continue;
        }
        out.push(part);
        continue;
      }
      const effectiveMime = resolveEffectiveImageMime(
        parsed.mimeType,
        decodeBase64Prefix(parsed.base64),
      );
      if (!isModelAcceptedImageMime(effectiveMime)) {
        out.push({ type: 'text', text: buildUnsupportedImageNotice(effectiveMime) });
        continue;
      }
      const canonicalUrl = `data:${normalizeImageMime(effectiveMime)};base64,${parsed.base64}`;
      if (part.imageUrl.url !== canonicalUrl) {
        out.push({ type: 'image_url', imageUrl: { ...part.imageUrl, url: canonicalUrl } });
        continue;
      }
    }
    out.push(part);
  }
  return out;
}

/**
 * Compress any inline base64 image parts in a content-part list — used by
 * the MCP tool-result path (prompt ingestion compresses per image with
 * {@link compressBase64ForModel} while constructing the part). Image parts
 * whose URL is not a `data:` URL (e.g. a remote http(s) image) are passed
 * through, as are non-image parts. Best effort: a part that fails to
 * compress is left unchanged.
 *
 * The format gate ({@link gateImageFormatParts}) runs first: parts whose
 * MIME is outside the provider-accepted set are never forwarded — the part
 * is dropped and a text notice stands in, so one unsupported image cannot
 * poison the session history. This is the MCP funnel's enforcement point —
 * MCP servers can return any `image/*` MIME (e.g. AVIF from an image search
 * tool).
 *
 * With `annotate` set, every image that was actually re-encoded gets a
 * caption in {@link CompressedContentParts.captions} so the model knows it
 * is looking at a downsampled copy. `annotate.persistOriginal` additionally
 * saves the pre-compression bytes and puts the returned path in the caption
 * so the model can read the original back; persistence failures degrade to
 * a caption without a path.
 */
export async function compressImageContentParts(
  parts: readonly ContentPart[],
  options: CompressImageOptions & { readonly annotate?: CompressAnnotateOptions } = {},
): Promise<CompressedContentParts> {
  const { annotate, ...compressOptions } = options;
  const out: ContentPart[] = [];
  const captions: string[] = [];
  for (const part of gateImageFormatParts(parts)) {
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
            captions.push(
              buildImageCompressionCaption({
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
            );
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
  return { parts: out, captions };
}

export interface CompressAnnotateOptions {
  /**
   * Persist the pre-compression original bytes somewhere the model can read
   * them back; return the absolute path, or null when persistence failed.
   */
  readonly persistOriginal?: (bytes: Uint8Array, mimeType: string) => Promise<string | null>;
}

// ── crop ─────────────────────────────────────────────────────────────

/**
 * Crop rectangle in ORIGINAL-image pixel coordinates — the decoded,
 * EXIF-rotated space that compression results report as the original size.
 */
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
  const startedAt = Date.now();
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);

  const fail = (errorKind: CropErrorKind, error: string): CropImageFailure => {
    reportCropEvent(options.telemetry, { startedAt, ok: false, errorKind });
    return { ok: false, error };
  };
  const succeed = (result: CropImageSuccess): CropImageSuccess => {
    reportCropEvent(options.telemetry, { startedAt, ok: true, result });
    return result;
  };

  if (bytes.length === 0) {
    return fail('empty', 'The image is empty.');
  }
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return fail(
      'unsupported_format',
      `Cropping is only supported for PNG, JPEG, and WebP images; got ${mimeType}.`,
    );
  }
  // A crop is a still image by definition; decoding an animated WebP would
  // silently crop a single frame, so refuse explicitly.
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return fail('unsupported_format', 'Cropping is not supported for animated WebP images.');
  }
  // NaN slips past every </>= comparison in the bounds guard below, so gate
  // on finiteness explicitly rather than surfacing a codec-internal error.
  if (
    ![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value))
  ) {
    return fail(
      'region_invalid',
      `Region coordinates must be finite numbers; got x=${String(region.x)}, ` +
        `y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    );
  }
  const dims = sniffImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return fail(
      'too_large',
      `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    );
  }
  if (bytes.length > maxDecodeBytes) {
    return fail('too_large', 'The image is too large to decode for cropping.');
  }

  // Try the Rust native codec first.
  const nativeOutcome = await tryNativeCropImage(
    bytes,
    normalizedMime,
    region.x,
    region.y,
    region.width,
    region.height,
    {
      maxEdge,
      byteBudget,
      skipResize: options.skipResize ?? false,
      fallbackEdges: FALLBACK_EDGES_PX,
      jpegQualitySteps: JPEG_QUALITY_STEPS,
    },
  );
  if (nativeOutcome !== undefined) {
    if (!nativeOutcome.ok) {
      return fail(nativeOutcome.errorKind as CropErrorKind, nativeOutcome.error);
    }
    return succeed({
      ok: true,
      data: nativeOutcome.data,
      mimeType: nativeOutcome.mimeType,
      width: nativeOutcome.width,
      height: nativeOutcome.height,
      originalWidth: nativeOutcome.originalWidth,
      originalHeight: nativeOutcome.originalHeight,
      region: {
        x: nativeOutcome.regionX,
        y: nativeOutcome.regionY,
        width: nativeOutcome.regionWidth,
        height: nativeOutcome.regionHeight,
      },
      resized: nativeOutcome.resized,
      originalByteLength: bytes.length,
      finalByteLength: nativeOutcome.finalByteLength,
    });
  }

  // Native unavailable — return failure.
  return fail('decode_failed', 'Image codec not available; native module is required for image operations.');
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
 *  - Tool results (MCP images): {@link compressImageContentParts} returns
 *    the captions as data and the MCP output pipeline joins them into the
 *    result's `note` side channel (rendered to the model at projection
 *    time, never to UIs).
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

// ── telemetry ────────────────────────────────────────────────────────

/** Failure classification carried by the `image_crop` event. */
type CropErrorKind =
  | 'empty'
  | 'unsupported_format'
  | 'region_invalid'
  | 'too_large'
  | 'out_of_bounds'
  | 'budget'
  | 'decode_failed';

/** The subset of a compression result the `image_compress` event reads. */
interface CompressEventResult {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Emit the `image_compress` event. Properties are all numeric/enum — never
 * paths or content — and a throwing client is swallowed so telemetry can
 * never affect the compression result.
 */
function reportCompressEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly outcome: CompressOutcome;
    readonly startedAt: number;
    readonly inputMime: string;
    readonly exifTransposed: boolean;
    readonly result: CompressEventResult;
  },
): void {
  if (telemetry === undefined) return;
  try {
    telemetry.client.track('image_compress', {
      source: telemetry.source,
      outcome: input.outcome,
      input_mime: input.inputMime,
      output_mime: normalizeImageMime(input.result.mimeType),
      original_bytes: input.result.originalByteLength,
      final_bytes: input.result.finalByteLength,
      original_width: input.result.originalWidth,
      original_height: input.result.originalHeight,
      final_width: input.result.width,
      final_height: input.result.height,
      exif_transposed: input.exifTransposed,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {
    // Telemetry must never affect the compression result.
  }
}

/**
 * Emit the `image_crop` event. Reports the region as a share of the original
 * pixel area rather than raw coordinates.
 */
function reportCropEvent(
  telemetry: ImageCompressionTelemetry | undefined,
  input: {
    readonly startedAt: number;
    readonly ok: boolean;
    readonly errorKind?: CropErrorKind;
    readonly result?: CropImageSuccess;
  },
): void {
  if (telemetry === undefined) return;
  try {
    const { result } = input;
    const originalPixels =
      result === undefined ? 0 : result.originalWidth * result.originalHeight;
    telemetry.client.track('image_crop', {
      source: telemetry.source,
      ok: input.ok,
      error_kind: input.errorKind,
      resized: result?.resized,
      original_width: result?.originalWidth,
      original_height: result?.originalHeight,
      region_area_ratio:
        result === undefined || originalPixels === 0
          ? undefined
          : (result.region.width * result.region.height) / originalPixels,
      final_bytes: result?.finalByteLength,
      duration_ms: Date.now() - input.startedAt,
    });
  } catch {
    // Telemetry must never affect the crop outcome.
  }
}
