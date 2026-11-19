import { expect, it } from 'vitest';
import { createMarkdownImageSizes, pendingImageIndex, pendingImageSrc, type ImageSize } from './imageSizes';

it('keys sizes by the original source for pending and resolved display sources', () => {
  const sizes = new Map<string, ImageSize>();
  const resolved = new Map([['a.png', 'blob:a']]);
  const sourceOf = (src: string) => {
    const index = pendingImageIndex(src);
    if (index !== null) return { key: ['a.png', 'b.png'][index]!, pending: true };
    for (const [original, url] of resolved) if (url === src) return { key: original, pending: false };
    return { key: src, pending: false };
  };
  const store = createMarkdownImageSizes(sizes, sourceOf);
  expect(store.lookup(pendingImageSrc(0))).toEqual({ pending: true, size: undefined });
  store.remember(pendingImageSrc(0), 1, 1);
  store.remember('blob:a', 640, 320);
  store.remember('blob:a', 1, 1);
  expect(store.lookup(pendingImageSrc(0))).toEqual({ pending: true, size: [640, 320] });
  expect(store.lookup('https://example.com/x.png')).toEqual({ pending: false, size: undefined });
  expect(pendingImageIndex('https://example.com/x.png')).toBeNull();
});
