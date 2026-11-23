const MODEL_SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function isModelSupportedImageMime(mime: string): boolean {
  const base = mime.split(';', 1)[0]!.trim().toLowerCase();
  return MODEL_SUPPORTED_IMAGE_MIMES.has(base === 'image/jpg' ? 'image/jpeg' : base);
}
