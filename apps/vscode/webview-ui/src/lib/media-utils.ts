import { heicTo } from "heic-to/csp";
import { IMAGE_CONFIG, VIDEO_CONFIG, MEDIA_CONFIG } from "@/services/config";

export { IMAGE_CONFIG, VIDEO_CONFIG, MEDIA_CONFIG };

export type MediaType = "image" | "video";

export interface MediaValidationError {
  type: "format" | "size" | "count";
  message: string;
}

const IMAGE_TYPES = new Set<string>(IMAGE_CONFIG.allowedTypes);
const VIDEO_TYPES = new Set<string>(VIDEO_CONFIG.allowedTypes);

function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isHeicFile(file: File): boolean {
  if (file.type === "image/heic" || file.type === "image/heif") {
    return true;
  }
  const ext = getExtension(file.name);
  return ext === "heic" || ext === "heif";
}

export function getMediaType(file: File): MediaType | null {
  if (IMAGE_TYPES.has(file.type)) {
    return "image";
  }
  if (VIDEO_TYPES.has(file.type)) {
    return "video";
  }
  if (isHeicFile(file)) {
    return "image";
  }
  return null;
}

export function getMediaTypeFromDataUri(dataUri: string): MediaType | null {
  if (dataUri.startsWith("data:image/")) {
    return "image";
  }
  if (dataUri.startsWith("data:video/")) {
    return "video";
  }
  return null;
}

// ============ Validation ============

export function validateMediaFile(file: File, currentCount: number): MediaValidationError | null {
  if (currentCount >= MEDIA_CONFIG.maxCount) {
    return { type: "count", message: `Maximum ${MEDIA_CONFIG.maxCount} media files allowed` };
  }

  const mediaType = getMediaType(file);
  if (!mediaType) {
    return { type: "format", message: "Unsupported format. Use PNG, JPEG, GIF, WebP, HEIC, MP4, WebM or MOV" };
  }

  const maxSize = mediaType === "image" ? IMAGE_CONFIG.maxSizeBytes : VIDEO_CONFIG.maxSizeBytes;
  if (file.size > maxSize) {
    return { type: "size", message: `File exceeds ${maxSize / (1024 * 1024)}MB limit` };
  }

  return null;
}

// ============ Processing Helpers ============

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function getScaledDimensions(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) {
    return { width: w, height: h };
  }
  const ratio = Math.min(max / w, max / h);
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

function canvasToDataUri(img: HTMLImageElement, mime: string, w: number, h: number, quality: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(mime, quality);
}

function dataUriSize(dataUri: string): number {
  const base64 = dataUri.split(",")[1];
  return Math.round((base64.length * 3) / 4);
}

// ============ Processing ============

async function processImage(file: File): Promise<string> {
  let blob: Blob = file;
  let mime = file.type;

  // Convert HEIC to JPEG
  if (isHeicFile(file)) {
    blob = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
    mime = "image/jpeg";
  }

  const dataUri = await blobToDataUri(blob);
  const img = await loadImage(dataUri);
  const { width, height } = getScaledDimensions(img.width, img.height, IMAGE_CONFIG.maxDimension);
  const needsResize = width !== img.width || height !== img.height;
  const isCompressible = mime === "image/jpeg" || mime === "image/webp";

  // No processing needed
  if (!needsResize && blob.size <= IMAGE_CONFIG.compressThresholdBytes) {
    return dataUri;
  }

  // Resize if needed
  let result = needsResize ? canvasToDataUri(img, mime, width, height, 1) : dataUri;

  // Compress if still too large
  if (isCompressible && dataUriSize(result) > IMAGE_CONFIG.compressThresholdBytes) {
    for (let q = 0.85; q >= 0.5; q -= 0.1) {
      result = canvasToDataUri(img, mime, width, height, q);
      if (dataUriSize(result) <= IMAGE_CONFIG.targetCompressedBytes) {
        break;
      }
    }
  }

  return result;
}

export async function processMediaFile(file: File): Promise<string> {
  return getMediaType(file) === "video" ? blobToDataUri(file) : processImage(file);
}
