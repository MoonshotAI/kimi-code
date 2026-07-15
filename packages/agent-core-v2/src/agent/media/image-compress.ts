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
 *    unchanged (`changed: false`). Callers must verify that this unchanged
 *    result satisfies their delivery limits before forwarding it.
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
import { isAnimatedWebp } from './webp-animated';
import { tryNativeCompressImage, tryNativeCropImage } from '../../_base/native-tools';

export const MAX_IMAGE_EDGE_PX = 2000;

let configuredMaxImageEdgePx: number | undefined;

export function setConfiguredMaxImageEdgePx(value: number | undefined): void {
  configuredMaxImageEdgePx = value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveMaxImageEdgePx(): number {
  return configuredMaxImageEdgePx ?? MAX_IMAGE_EDGE_PX;
}

export const IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

let configuredReadImageByteBudget: number | undefined;

export function setConfiguredReadImageByteBudget(value: number | undefined): void {
  configuredReadImageByteBudget =
    value !== undefined && isPositiveInt(value) ? value : undefined;
}

export function resolveReadImageByteBudget(): number {
  return configuredReadImageByteBudget ?? READ_IMAGE_BYTE_BUDGET;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

const PNG_RESCALE_FLOOR_PX = 1000;

const MAX_DECODE_PIXELS = 100_000_000;

export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
  readonly telemetry?: ImageCompressionTelemetry;
}

export interface ImageCompressionTelemetryClient {
  track(
    event: string,
    properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void;
}

export interface ImageCompressionTelemetry {
  readonly client: ImageCompressionTelemetryClient;
  readonly source: string;
}

type CompressOutcome =
  | 'compressed'
  | 'passthrough_fast'
  | 'passthrough_guard'
  | 'passthrough_unsupported'
  | 'passthrough_unhelpful'
  | 'passthrough_error';

export interface CompressImageResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

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
  if (!RECODABLE_MIME.has(normalizedMime)) return finish('passthrough_unsupported', passthrough());
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return finish('passthrough_unsupported', passthrough());
  }

  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) {
    return finish('passthrough_fast', passthrough());
  }

  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return finish('passthrough_guard', passthrough());
  }
  if (bytes.length > maxDecodeBytes) return finish('passthrough_guard', passthrough());

  // Try the Rust native codec first.
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

  return finish('passthrough_unhelpful', passthrough());
}

export interface CompressBase64Result {
  readonly base64: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export async function compressBase64ForModel(
  base64: string,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressBase64Result> {
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
  readonly parts: ContentPart[];
  readonly captions: readonly string[];
}

export function gateImageFormatParts(parts: readonly ContentPart[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const parsed = parseImageDataUrl(part.imageUrl.url);
      if (parsed === null) {
        if (isDataUrl(part.imageUrl.url)) {
          out.push({ type: 'text', text: buildMalformedImageNotice(part.imageUrl.url) });
          continue;
        }
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
  readonly persistOriginal?: (bytes: Uint8Array, mimeType: string) => Promise<string | null>;
}


export interface ImageCropRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropImageOptions extends CompressImageOptions {
  readonly skipResize?: boolean;
}

export interface CropImageSuccess {
  readonly ok: true;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly region: ImageCropRegion;
  readonly resized: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

export interface CropImageFailure {
  readonly ok: false;
  readonly error: string;
}

export type CropImageOutcome = CropImageSuccess | CropImageFailure;

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
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return fail('unsupported_format', 'Cropping is not supported for animated WebP images.');
  }
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

  return fail('decode_failed', 'Image codec not available; native module is required for image operations.');
}


export interface ImageVariantDescription {
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface ImageCompressionCaptionInput {
  readonly original: ImageVariantDescription;
  readonly final: ImageVariantDescription;
  readonly originalPath?: string | null;
}

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

const CAPTION_OPENING = '<system>Image compressed to fit model limits:';

const CAPTION_PATTERN = /<system>(Image compressed to fit model limits:[\s\S]*?)<\/system>/g;

export interface ImageCompressionCaptionExtraction {
  readonly captions: readonly string[];
  readonly text: string;
}

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

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


type CropErrorKind =
  | 'empty'
  | 'unsupported_format'
  | 'region_invalid'
  | 'too_large'
  | 'out_of_bounds'
  | 'budget'
  | 'decode_failed';

interface CompressEventResult {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

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
  }
}

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
  }
}
