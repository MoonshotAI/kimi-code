import type { InjectionKey } from 'vue';

export const IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export type ImageSize = readonly [width: number, height: number];

export interface ImageSizeInfo {
  pending: boolean;
  size?: ImageSize;
}

export interface MarkdownImageSizes {
  lookup(src: string): ImageSizeInfo;
  remember(src: string, width: number, height: number): void;
}

export const MarkdownImageSizesKey: InjectionKey<MarkdownImageSizes> = Symbol('markdown-image-sizes');

const PENDING_PREFIX = `${IMAGE_PLACEHOLDER}#`;

export function pendingImageSrc(index: number): string {
  return `${PENDING_PREFIX}${index}`;
}

export function pendingImageIndex(src: string): number | null {
  if (!src.startsWith(PENDING_PREFIX)) return null;
  const index = Number(src.slice(PENDING_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function createMarkdownImageSizes(
  sizes: Map<string, ImageSize>,
  sourceOf: (src: string) => { key: string; pending: boolean },
): MarkdownImageSizes {
  return {
    lookup(src) {
      const { key, pending } = sourceOf(src);
      return { pending, size: sizes.get(key) };
    },
    remember(src, width, height) {
      if (!(width > 1 && height > 1)) return;
      const { key, pending } = sourceOf(src);
      if (pending) return;
      const previous = sizes.get(key);
      if (previous?.[0] === width && previous[1] === height) return;
      sizes.set(key, [width, height]);
    },
  };
}
