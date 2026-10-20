import {
  MAX_IMAGE_DECODE_BYTES,
  compressImage,
  type CompressImageOptions,
} from '@moonshot-ai/agent-core/image/index';

import { DEFAULT_INLINE_IMAGE_BYTE_BUDGET } from '../inspect/format-policy';

export { MAX_IMAGE_DECODE_BYTES, MAX_IMAGE_EDGE_PX } from '@moonshot-ai/agent-core/image/index';

export const IMAGE_BYTE_BUDGET = DEFAULT_INLINE_IMAGE_BYTE_BUDGET;

export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

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
  const unchanged = (overrides: Partial<CompressBase64Result> = {}): CompressBase64Result => ({
    base64,
    mimeType,
    width: 0,
    height: 0,
    originalWidth: 0,
    originalHeight: 0,
    changed: false,
    originalByteLength: approxBytes,
    finalByteLength: approxBytes,
    ...overrides,
  });
  if (approxBytes > maxDecodeBytes) return unchanged();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return unchanged({ originalByteLength: 0, finalByteLength: 0 });
  }
  const result = await compressImage(bytes, mimeType, options);
  if (!result.changed) {
    return unchanged({
      width: result.width,
      height: result.height,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      originalByteLength: result.originalByteLength,
      finalByteLength: result.finalByteLength,
    });
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
