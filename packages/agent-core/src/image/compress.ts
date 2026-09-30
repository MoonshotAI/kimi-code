import { sniffImageDimensions } from './dimensions';
import { decodeWebp, isAnimatedWebp } from './webp';

export const MAX_IMAGE_EDGE_PX = 2000;
export const DEFAULT_IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;
const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;
const PNG_RESCALE_FLOOR_PX = 1000;
const MAX_DECODE_PIXELS = 100_000_000;
const RECODABLE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function normalizeImageMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  return lower === 'image/jpg' || lower === 'image/pjpeg' ? 'image/jpeg' : lower;
}

export function isRecodableImage(bytes: Uint8Array, mimeType: string): boolean {
  const normalized = normalizeImageMime(mimeType);
  if (!RECODABLE_MIME.has(normalized)) return false;
  return normalized !== 'image/webp' || !isAnimatedWebp(bytes);
}

export interface CompressImageOptions {
  readonly maxEdge?: number;
  readonly byteBudget?: number;
  readonly maxDecodeBytes?: number;
}

export type CompressOutcome =
  | 'compressed'
  | 'passthrough_fast'
  | 'passthrough_guard'
  | 'passthrough_unsupported'
  | 'passthrough_unhelpful'
  | 'passthrough_error';

export interface CompressImageResult {
  readonly outcome: CompressOutcome;
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly changed: boolean;
  readonly exifTransposed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
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

async function encodeWithinBudget(
  image: JimpImage,
  preferLossless: boolean,
  byteBudget: number,
): Promise<EncodedImage> {
  let smallest: EncodedImage | null = null;
  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) smallest = candidate;
    return candidate;
  };
  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer('image/jpeg', { quality });
      const candidate = consider(jpeg, 'image/jpeg');
      if (jpeg.length <= byteBudget) return candidate;
    }
    return null;
  };

  if (preferLossless) {
    const png = await image.getBuffer('image/png', { deflateLevel: 9 });
    if (png.length <= byteBudget) return consider(png, 'image/png');
    consider(png, 'image/png');
    for (const edge of FALLBACK_EDGES_PX) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      if (!fitWithinEdge(image, edge)) continue;
      const smaller = await image.getBuffer('image/png', { deflateLevel: 9 });
      if (smaller.length <= byteBudget) return consider(smaller, 'image/png');
      consider(smaller, 'image/png');
    }
    const atFloor = await jpegLadder();
    if (atFloor !== null) return atFloor;
    for (const edge of FALLBACK_EDGES_PX) {
      if (edge >= PNG_RESCALE_FLOOR_PX || !fitWithinEdge(image, edge)) continue;
      const atEdge = await jpegLadder();
      if (atEdge !== null) return atEdge;
    }
    return smallest!;
  }

  const fitted = await jpegLadder();
  if (fitted !== null) return fitted;
  for (const edge of FALLBACK_EDGES_PX) {
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }
  return smallest!;
}

export async function compressImage(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
  const dims = sniffImageDimensions(bytes);
  const passthrough = (outcome: CompressOutcome): CompressImageResult => ({
    outcome,
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    exifTransposed: dims?.transposed === true,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });

  if (bytes.length === 0 || !isRecodableImage(bytes, normalizedMime)) {
    return passthrough('passthrough_unsupported');
  }
  const longestEdge = dims === null ? 0 : Math.max(dims.width, dims.height);
  if (bytes.length <= byteBudget && longestEdge <= maxEdge) return passthrough('passthrough_fast');
  if ((dims !== null && dims.width * dims.height > MAX_DECODE_PIXELS) || bytes.length > maxDecodeBytes) {
    return passthrough('passthrough_guard');
  }
  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const decodedWidth = image.width;
    const decodedHeight = image.height;
    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, normalizedMime !== 'image/jpeg', byteBudget);
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = encoded.width * encoded.height < decodedWidth * decodedHeight;
    if (!shrankBytes && !shrankPixels) return passthrough('passthrough_unhelpful');
    return {
      outcome: 'compressed',
      data: new Uint8Array(encoded.data),
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      exifTransposed: dims?.transposed === true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch {
    return passthrough('passthrough_error');
  }
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

export type CropErrorKind =
  | 'empty'
  | 'unsupported_format'
  | 'region_invalid'
  | 'too_large'
  | 'out_of_bounds'
  | 'budget'
  | 'decode_failed';

export type CropImageOutcome =
  | {
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
  | { readonly ok: false; readonly errorKind: CropErrorKind; readonly error: string };

export async function cropImage(
  bytes: Uint8Array,
  mimeType: string,
  region: ImageCropRegion,
  options: CropImageOptions = {},
): Promise<CropImageOutcome> {
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE_PX;
  const byteBudget = options.byteBudget ?? DEFAULT_IMAGE_BYTE_BUDGET;
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
  const fail = (errorKind: CropErrorKind, error: string): CropImageOutcome => ({ ok: false, errorKind, error });

  if (bytes.length === 0) return fail('empty', 'The image is empty.');
  if (!RECODABLE_MIME.has(normalizedMime)) {
    return fail('unsupported_format', `Cropping is only supported for PNG, JPEG, and WebP images; got ${mimeType}.`);
  }
  if (normalizedMime === 'image/webp' && isAnimatedWebp(bytes)) {
    return fail('unsupported_format', 'Cropping is not supported for animated WebP images.');
  }
  if (![region.x, region.y, region.width, region.height].every((value) => Number.isFinite(value))) {
    return fail(
      'region_invalid',
      `Region coordinates must be finite numbers; got x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}.`,
    );
  }
  const dims = sniffImageDimensions(bytes);
  if (dims !== null && dims.width * dims.height > MAX_DECODE_PIXELS) {
    return fail(
      'too_large',
      `The image (${String(dims.width)}x${String(dims.height)} pixels) is too large to decode for cropping.`,
    );
  }
  if (bytes.length > maxDecodeBytes) return fail('too_large', 'The image is too large to decode for cropping.');

  try {
    const image = await decodeToJimp(bytes, normalizedMime);
    const originalWidth = image.width;
    const originalHeight = image.height;
    const x = Math.floor(region.x);
    const y = Math.floor(region.y);
    if (x < 0 || y < 0 || x >= originalWidth || y >= originalHeight || region.width < 1 || region.height < 1) {
      return fail(
        'out_of_bounds',
        `Region (x=${String(region.x)}, y=${String(region.y)}, width=${String(region.width)}, height=${String(region.height)}) lies outside the ${String(originalWidth)}x${String(originalHeight)} image.`,
      );
    }
    const w = Math.min(Math.floor(region.width), originalWidth - x);
    const h = Math.min(Math.floor(region.height), originalHeight - y);
    image.crop({ x, y, w, h });
    const preferLossless = normalizedMime !== 'image/jpeg';
    const applied: ImageCropRegion = { x, y, width: w, height: h };
    const succeed = (encoded: EncodedImage, resized: boolean): CropImageOutcome => ({
      ok: true,
      data: new Uint8Array(encoded.data),
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth,
      originalHeight,
      region: applied,
      resized,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    });
    if (options.skipResize === true) {
      const data = preferLossless
        ? await image.getBuffer('image/png', { deflateLevel: 9 })
        : await image.getBuffer('image/jpeg', { quality: 90 });
      if (data.length > byteBudget) {
        return fail(
          'budget',
          `The cropped region encodes to ${String(data.length)} bytes, over the ${String(byteBudget)}-byte per-image limit. Choose a smaller region, or allow downscaling.`,
        );
      }
      const mime = preferLossless ? 'image/png' : 'image/jpeg';
      return succeed({ data, mimeType: mime, width: image.width, height: image.height }, false);
    }
    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, preferLossless, byteBudget);
    return succeed(encoded, encoded.width !== w || encoded.height !== h);
  } catch (error) {
    return fail(
      'decode_failed',
      `Failed to decode the image for cropping: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
