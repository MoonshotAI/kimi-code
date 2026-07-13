/**
 * `media` domain (L4) — image compression for model ingestion.
 *
 * Shrink oversized images before they reach the model.
 *
 * A multimodal request carries each image as a base64 data URL; an unbounded
 * screenshot or photo wastes context tokens and can blow past the provider's
 * per-image byte ceiling. This module downsamples and re-encodes such images
 * so they fit a pixel + byte budget, while leaving already-small images
 * untouched — the common case is a fast, codec-free pass-through.
 *
 * Design notes:
 *  - Pure JS (jimp + a wasm WebP decoder), imported lazily so the codecs are
 *    only paid for when an image actually needs work; startup and the fast
 *    path stay cheap.
 *  - Best effort: any decode/encode failure returns the original bytes
 *    unchanged (`changed: false`), so a compression problem never blocks a
 *    prompt. Callers simply send the original instead.
 *  - Format gate first: content-part lists pass through
 *    {@link gateImageFormatParts} before any compression, so images outside
 *    the provider-accepted set (see ./image-format-policy) are never decoded
 *    or forwarded — one unsupported image in the session history would make
 *    every subsequent request fail.
 *  - PNG, JPEG, and (non-animated) WebP are re-encoded; WebP re-encodes
 *    through the PNG/JPEG ladder after a wasm decode (see ./webp-decode).
 *    GIF and animated WebP are passed through to preserve animation. Formats
 *    outside the provider-accepted set never reach this module from the
 *    content-part paths (the format gate drops them first); direct callers
 *    get a passthrough.
 *  - Compression must never be silent to the model: results carry the
 *    original dimensions, {@link buildImageCompressionCaption} renders the
 *    shared "what was compressed, where is the original" note every ingestion
 *    point can place next to the image, and {@link cropImageForModel} lets a
 *    caller read a region of the original back at full fidelity. In user
 *    prompts the prompt layer later reroutes that note through the hidden
 *    system-reminder injection via {@link extractImageCompressionCaptions},
 *    so its raw `<system>` markup never renders in the UI.
 */

import type { ContentPart } from '#/app/llmProtocol/message';

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
import { decodeWebp, isAnimatedWebp } from './webp-decode';

/**
 * Built-in longest-edge ceiling (px). Larger images are scaled down to fit.
 * This is the default only: the effective ceiling is resolved per call by
 * {@link resolveMaxImageEdgePx} (explicit option > `[image] max_edge_px` config
 * > this). The config value is pushed by the media-domain image-config bridge,
 * which reads the env-resolved `image` section (`KIMI_IMAGE_MAX_EDGE_PX` wins
 * over the file value over there — this module never reads env directly).
 */
export const MAX_IMAGE_EDGE_PX = 2000;

/**
 * The `[image] max_edge_px` value, pushed by the image-config bridge on load
 * and on config change. Processes that never load config (or have no `[image]`
 * section) leave this unset and get the built-in ceiling.
 */
let configuredMaxImageEdgePx: number | undefined;

/** Push (or clear, with `undefined`) the configured longest-edge ceiling. */
export function setConfiguredMaxImageEdgePx(value: number | undefined): void {
  configuredMaxImageEdgePx = value !== undefined && isPositiveInt(value) ? value : undefined;
}

/**
 * Effective default longest-edge ceiling (px), for calls that pass no explicit
 * `maxEdge`. Precedence: configured `[image] max_edge_px` (env already folded
 * in by the config layer) > built-in {@link MAX_IMAGE_EDGE_PX}.
 */
export function resolveMaxImageEdgePx(): number {
  return configuredMaxImageEdgePx ?? MAX_IMAGE_EDGE_PX;
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
 * provider's per-image ceiling — is what keeps the total under the provider's
 * request-size limit. 256 KB keeps a clean UI screenshot on the lossless fast
 * path while capping dense content at a readable q80/1000px JPEG; fine detail
 * stays reachable through the `region` readback, which deliberately ignores
 * this budget. Overridden by `[image] read_byte_budget` (env
 * `KIMI_IMAGE_READ_BYTE_BUDGET` folded in by the config layer) via
 * {@link resolveReadImageByteBudget}.
 */
export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

/** The `[image] read_byte_budget` value; see {@link setConfiguredMaxImageEdgePx}. */
let configuredReadImageByteBudget: number | undefined;

/** Push (or clear, with `undefined`) the configured read-image byte budget. */
export function setConfiguredReadImageByteBudget(value: number | undefined): void {
  configuredReadImageByteBudget =
    value !== undefined && isPositiveInt(value) ? value : undefined;
}

/**
 * Effective read-image byte budget. Precedence mirrors
 * {@link resolveMaxImageEdgePx}: configured `[image] read_byte_budget` (env
 * already folded in by the config layer) > built-in
 * {@link READ_IMAGE_BYTE_BUDGET}.
 */
export function resolveReadImageByteBudget(): number {
  return configuredReadImageByteBudget ?? READ_IMAGE_BYTE_BUDGET;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
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
 * Floor below which lossless PNG rescaling stops and the encoder switches to
 * the lossy JPEG ladder: past ~1000px the PNG bytes barely shrink (entropy,
 * not dimensions, dominates) while readability keeps dropping — going
 * lossless all the way to 256px produced unreadable screenshots that a
 * modest JPEG would have beaten on both counts. Sub-floor edges still get
 * the JPEG ladder so small budgets converge.
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
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

/** Formats we can decode and re-encode. WebP decodes via the bundled wasm
 * codec and re-encodes through the PNG/JPEG ladder (animated WebP is gated
 * out per call site). */
const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface CompressImageOptions {
  /** Override the longest-edge ceiling (px). */
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

/**
 * Telemetry sink for the compression events. Deliberately a loose local
 * contract — this L0 support module must not import the app-layer telemetry
 * registry, so the payload shapes are checked only where the registry lives
 * (`#/app/telemetry/events`); any object with a compatible `track` slot
 * (e.g. the app-layer `ITelemetryService`) satisfies it structurally.
 */
export interface ImageCompressionTelemetryClient {
  track(
    event: string,
    properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void;
}

/** Wiring for the optional compression telemetry events. */
export interface ImageCompressionTelemetry {
  readonly client: ImageCompressionTelemetryClient;
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
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
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

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    // WebP joins PNG on the lossless-first ladder: both carry alpha and
    // screenshot-grade detail that the PNG rungs preserve.
    const preferLossless = normalizedMime !== 'image/jpeg';
    // The decoded bitmap is authoritative for the original size: jimp
    // applies EXIF orientation while decoding, and this is the coordinate
    // space the encoded result and any later crop region (see
    // cropImageForModel, which decodes the same way) actually live in. The
    // header sniff also reports display space, but can miss formats or
    // nonconforming EXIF that the decoder still handles.
    const decodedWidth = image.width;
    const decodedHeight = image.height;

    // Scale so the longest edge fits maxEdge (never enlarges).
    fitWithinEdge(image, maxEdge);

    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
    });

    // Keep the result when it actually helps: fewer bytes, or fewer pixels
    // (a smaller image costs fewer vision tokens even if the byte count is
    // flat, as with near-solid graphics). Otherwise the re-encode bought us
    // nothing — send the original.
    const originalPixels = decodedWidth * decodedHeight;
    const finalPixels = encoded.width * encoded.height;
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = finalPixels < originalPixels;
    if (!shrankBytes && !shrankPixels) return finish('passthrough_unhelpful', passthrough());

    return finish('compressed', {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    });
  } catch {
    // Decode/encode failure — keep the original bytes.
    return finish('passthrough_error', passthrough());
  }
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
  const startedAt = Date.now();
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
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
 * the MCP tool-result path. Image parts whose URL is not a `data:` URL
 * (e.g. a remote http(s) image) are passed through, as are non-image parts.
 * Best effort: a part that fails to compress is left unchanged.
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
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_DECODE_BYTES;
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

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const originalWidth = image.width;
    const originalHeight = image.height;

    const x = Math.floor(region.x);
    const y = Math.floor(region.y);
    if (x < 0 || y < 0 || x >= originalWidth || y >= originalHeight || region.width < 1 || region.height < 1) {
      return fail(
        'out_of_bounds',
        `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, ` +
          `height=${String(region.height)}) lies outside the ${String(originalWidth)}x${String(originalHeight)} image.`,
      );
    }
    const w = Math.min(Math.floor(region.width), originalWidth - x);
    const h = Math.min(Math.floor(region.height), originalHeight - y);
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    image.crop({ x, y, w, h });
    // WebP joins PNG on the lossless side: both carry alpha and
    // screenshot-grade detail that PNG output preserves.
    const preferLossless = normalizedMime !== 'image/jpeg';

    if (options.skipResize === true) {
      // Native resolution requested: encode once, favoring fidelity (lossless
      // PNG, or high-quality JPEG), and refuse rather than degrade when the
      // result cannot fit the byte budget.
      const buffer = preferLossless
        ? await image.getBuffer('image/png', { deflateLevel: 9 })
        : await image.getBuffer('image/jpeg', { quality: 90 });
      if (buffer.length > byteBudget) {
        return fail(
          'budget',
          `The cropped region encodes to ${String(buffer.length)} bytes ` +
            `(${formatByteSize(buffer.length)}), over the ${String(byteBudget)}-byte ` +
            `(${formatByteSize(byteBudget)}) per-image limit. ` +
            'Choose a smaller region, or allow downscaling.',
        );
      }
      return succeed({
        ok: true,
        data: new Uint8Array(buffer),
        mimeType: preferLossless ? 'image/png' : 'image/jpeg',
        width: image.width,
        height: image.height,
        originalWidth,
        originalHeight,
        region: applied,
        resized: false,
        originalByteLength: bytes.length,
        finalByteLength: buffer.length,
      });
    }

    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
    });
    return succeed({
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
    });
  } catch (error) {
    return fail(
      'decode_failed',
      `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    );
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
 *  - Tool results (MCP images): {@link compressImageContentParts} returns
 *    the captions as data and the MCP output pipeline joins them into the
 *    result's `note` side channel (rendered to the model at projection
 *    time, never to UIs).
 *  - User prompts must not render raw `<system>` markup in the UI, so the
 *    prompt layer detects the caption via
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
 * and the prompt layer uses this to reroute the note through the built-in
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
  /** Lossless-first (PNG rungs before JPEG): PNG and WebP sources, which
   * carry alpha and screenshot-grade detail. JPEG sources skip straight to
   * the quality ladder — their detail is already lossy. */
  readonly preferLossless: boolean;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
}

/**
 * Decode `bytes` into a jimp image. PNG/JPEG decode through jimp itself
 * (which applies EXIF orientation); WebP decodes through the bundled wasm
 * codec and enters jimp as a raw RGBA bitmap (WebP carries no EXIF-style
 * orientation, so the decoded pixels are already display space).
 */
async function decodeToJimp(bytes: Uint8Array, normalizedMime: string): Promise<JimpImage> {
  const { Jimp } = await import('jimp');
  if (normalizedMime === 'image/webp') {
    const decoded = await decodeWebp(bytes);
    return Jimp.fromBitmap({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
  }
  return Jimp.fromBuffer(Buffer.from(bytes));
}

/**
 * Encode `image` (already fitted to the edge ceiling) under the byte budget.
 *
 * Strategy — prefer the source format so a downscaled screenshot stays lossless
 * PNG (preserving text and transparency), and only fall back to lossy JPEG when
 * PNG cannot meet the byte budget:
 *  - PNG source: PNG at the fitted size → smaller PNG rescales down to the
 *    {@link PNG_RESCALE_FLOOR_PX} floor → JPEG ladder at that size → JPEG
 *    ladder again at each sub-floor edge.
 *  - JPEG source: the full quality ladder at the fitted size, then again at
 *    each fallback edge — a smaller rescale must not skip the high-quality
 *    rungs its extra pixels just paid for.
 *
 * The sub-floor edges make the ladder converge for small (read-scale)
 * budgets: any budget of a few tens of KB is met by q20 at 256px even for
 * entropy-upper-bound content. Below that, the smallest buffer produced is
 * still returned — the caller gates on whether it actually helped.
 */
async function encodeWithinBudget(image: JimpImage, opts: EncodeOptions): Promise<EncodedImage> {
  const { preferLossless, byteBudget, fallbackEdges } = opts;
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) {
      smallest = candidate;
    }
    return candidate;
  };

  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      if (jpeg.length <= byteBudget) return consider(jpeg, 'image/jpeg');
      consider(jpeg, 'image/jpeg');
    }
    return null;
  };

  if (preferLossless) {
    // Lossless PNG first: best for screenshots/UI (sharp text) and keeps alpha.
    const png = await image.getBuffer('image/png', { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, 'image/png');
    consider(png, 'image/png');

    // Over budget: progressively smaller PNGs (down to the floor) before
    // going lossy.
    for (const edge of fallbackEdges) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      if (!fitWithinEdge(image, edge)) continue;
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 });
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png');
      consider(smallerPng, 'image/png');
    }

    // Lossy JPEG ladder (drops transparency) at the floored size, then at
    // each sub-floor edge until the budget is met.
    const atFloor = await jpegLadder();
    if (atFloor !== null) return atFloor;
    for (const edge of fallbackEdges) {
      if (edge >= PNG_RESCALE_FLOOR_PX) continue;
      if (!fitWithinEdge(image, edge)) continue;
      const atEdge = await jpegLadder();
      if (atEdge !== null) return atEdge;
    }
    return smallest!;
  }

  // JPEG source: quality ladder at the fitted size, then the full ladder
  // again at each fallback rescale.
  const atFitted = await jpegLadder();
  if (atFitted !== null) return atFitted;
  for (const edge of fallbackEdges) {
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }

  return smallest!;
}

/**
 * Scale `image` so its longest edge is at most `edge`, preserving aspect
 * ratio. No-op (returns false) when the image already fits.
 *
 * Deliberately passes no `mode`: without one, jimp's default resizer
 * downscales with a full-coverage area average (every source pixel
 * contributes to the output), which does not alias. The named
 * ResizeStrategy modes (BILINEAR, BICUBIC, …) switch to point-sampled
 * interpolation that skips source pixels beyond ~2x reduction and produces
 * moiré on text and fine patterns — do not "upgrade" this call to one.
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
