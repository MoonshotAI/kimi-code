import type { ContentPart } from '@moonshot-ai/agent-core';

import { sniffImageDimensions } from '../inspect/file-type';
import {
  DEFAULT_INLINE_IMAGE_BYTE_BUDGET,
  buildMalformedImageNotice,
  buildUnsupportedImageNotice,
  decodeBase64Prefix,
  isDataUrl,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  resolveEffectiveImageMime,
  unsupportedImageMimeFromUrl,
} from '../inspect/format-policy';
import { decodeWebp, isAnimatedWebp } from './webp/decode';

export const MAX_IMAGE_EDGE_PX = 2000;

export const IMAGE_BYTE_BUDGET = DEFAULT_INLINE_IMAGE_BYTE_BUDGET;

export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

const PNG_RESCALE_FLOOR_PX = 1000;

const MAX_DECODE_PIXELS = 100_000_000;

export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function isRecodableImage(bytes: Uint8Array, mimeType: string): boolean {
  const normalizedMime = normalizeImageMime(mimeType);
  if (!RECODABLE_MIME.has(normalizedMime)) return false;
  return normalizedMime !== 'image/webp' || !isAnimatedWebp(bytes);
}

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
}

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
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
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

  if (bytes.length === 0 || !isRecodableImage(bytes, normalizedMime)) {
    return passthrough();
  }

  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) {
    return passthrough();
  }

  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return passthrough();
  }
  if (bytes.length > maxDecodeBytes) return passthrough();

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const preferLossless = normalizedMime !== 'image/jpeg';
    const decodedWidth = image.width;
    const decodedHeight = image.height;

    fitWithinEdge(image, maxEdge);

    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
    });

    const originalPixels = decodedWidth * decodedHeight;
    const finalPixels = encoded.width * encoded.height;
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = finalPixels < originalPixels;
    if (!shrankBytes && !shrankPixels) return passthrough();

    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch {
    return passthrough();
  }
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
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
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

export function gateImageFormatParts(
  parts: readonly ContentPart[],
  providerType?: string,
): ContentPart[] {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      const source = part.source;
      if (source.kind === 'url' && !isDataUrl(source.url)) {
        const extMime = unsupportedImageMimeFromUrl(source.url, providerType);
        if (extMime !== null) {
          out.push({
            type: 'text',
            text: buildUnsupportedImageNotice(extMime, source.url, providerType),
          });
          continue;
        }
        out.push(part);
        continue;
      }
      if (source.kind === 'inline' || source.kind === 'url') {
        let parsed: { mimeType: string; base64: string } | null;
        if (source.kind === 'inline') {
          parsed = { mimeType: source.mimeType, base64: source.data };
        } else {
          parsed = parseImageDataUrl(source.url);
          if (parsed === null) {
            out.push({ type: 'text', text: buildMalformedImageNotice(source.url) });
            continue;
          }
        }
        const effectiveMime = resolveEffectiveImageMime(
          parsed.mimeType,
          decodeBase64Prefix(parsed.base64),
        );
        if (!isModelAcceptedImageMime(effectiveMime, providerType)) {
          out.push({
            type: 'text',
            text: buildUnsupportedImageNotice(effectiveMime, undefined, providerType),
          });
          continue;
        }
        const canonicalMime = normalizeImageMime(effectiveMime);
        if (source.kind === 'url' || source.mimeType !== canonicalMime) {
          out.push({
            ...part,
            source: { kind: 'inline', mimeType: canonicalMime, data: parsed.base64 },
          });
          continue;
        }
      }
    }
    out.push(part);
  }
  return out;
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
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);

  const fail = (error: string): CropImageFailure => ({ ok: false, error });

  if (bytes.length === 0) {
    return fail('The image is empty.');
  }
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return fail(
      `Cropping is only supported for PNG, JPEG, and WebP images; got ${mimeType}.`,
    );
  }
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return fail('Cropping is not supported for animated WebP images.');
  }
  if (
    ![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value))
  ) {
    return fail(
      `Region coordinates must be finite numbers; got x=${String(region.x)}, ` +
        `y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    );
  }
  const dims = sniffImageDimensions(bytes);
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return fail(
      `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    );
  }
  if (bytes.length > maxDecodeBytes) {
    return fail('The image is too large to decode for cropping.');
  }

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const originalWidth = image.width;
    const originalHeight = image.height;

    const x = Math.floor(region.x);
    const y = Math.floor(region.y);
    if (x < 0 || y < 0 || x >= originalWidth || y >= originalHeight || region.width < 1 || region.height < 1) {
      return fail(
        `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, ` +
          `height=${String(region.height)}) lies outside the ${String(originalWidth)}x${String(originalHeight)} image.`,
      );
    }
    const w = Math.min(Math.floor(region.width), originalWidth - x);
    const h = Math.min(Math.floor(region.height), originalHeight - y);
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    image.crop({ x, y, w, h });
    const preferLossless = normalizedMime !== 'image/jpeg';

    if (options.skipResize === true) {
      const buffer = preferLossless
        ? await image.getBuffer('image/png', { deflateLevel: 9 })
        : await image.getBuffer('image/jpeg', { quality: 90 });
      if (buffer.length > byteBudget) {
        return fail(
          `The cropped region encodes to ${String(buffer.length)} bytes ` +
            `(${formatByteSize(buffer.length)}), over the ${String(byteBudget)}-byte ` +
            `(${formatByteSize(byteBudget)}) per-image limit. ` +
            'Choose a smaller region, or allow downscaling.',
        );
      }
      return {
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
      };
    }

    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, {
      preferLossless,
      byteBudget,
      fallbackEdges: FALLBACK_EDGES_PX,
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
    return fail(
      `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly preferLossless: boolean;
  readonly byteBudget: number;
  readonly fallbackEdges: readonly number[];
}

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
    const png = await image.getBuffer('image/png', { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, 'image/png');
    consider(png, 'image/png');

    for (const edge of fallbackEdges) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      if (!fitWithinEdge(image, edge)) continue;
      const smallerPng = await image.getBuffer('image/png', { deflateLevel: 9 });
      if (smallerPng.length <= byteBudget) return consider(smallerPng, 'image/png');
      consider(smallerPng, 'image/png');
    }

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

  const atFitted = await jpegLadder();
  if (atFitted !== null) return atFitted;
  for (const edge of fallbackEdges) {
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }

  return smallest!;
}

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
