export const IMAGE_CONFIG = {
  maxSizeBytes: 10 * 1024 * 1024,
  maxDimension: 4096,
  compressThresholdBytes: 5 * 1024 * 1024,
  targetCompressedBytes: 2 * 1024 * 1024,
  allowedTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"] as const,
} as const;

export const VIDEO_CONFIG = {
  maxSizeBytes: 20 * 1024 * 1024,
  allowedTypes: ["video/mp4", "video/webm", "video/quicktime"] as const,
} as const;

export const MEDIA_CONFIG = {
  maxCount: 9,
} as const;

export const FILE_PICKER_CONFIG = {
  maxSearchResults: 30,
  maxDisplayLength: 25,
} as const;
