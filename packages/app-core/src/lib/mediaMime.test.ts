import { describe, expect, it } from 'vitest';
import { isModelSupportedImageMime } from './mediaMime';

describe('isModelSupportedImageMime', () => {
  it.each(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'IMAGE/PNG; charset=binary'])(
    'accepts %s',
    (mime) => expect(isModelSupportedImageMime(mime)).toBe(true),
  );

  it.each(['image/svg+xml', 'image/avif', 'image/heic', 'image/bmp', 'application/pdf'])(
    'rejects %s',
    (mime) => expect(isModelSupportedImageMime(mime)).toBe(false),
  );
});
