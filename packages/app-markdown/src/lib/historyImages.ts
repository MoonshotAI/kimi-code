import type { InjectionKey } from 'vue';

type ImageEntry = { text: string; images: Map<string, string>; bytes: number };

export function createHistoryImageCache() {
  const entries = new Map<object, ImageEntry>();
  let bytes = 0;
  let count = 0;
  const remove = (key: object) => {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    count -= entry.images.size;
    entries.delete(key);
  };
  return {
    get(key: object, text: string): ReadonlyMap<string, string> | undefined {
      const entry = entries.get(key);
      if (!entry) return;
      if (entry.text !== text) {
        remove(key);
        return;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.images;
    },
    set(key: object, text: string, resolved: ReadonlyMap<string, string>): void {
      remove(key);
      const images = new Map([...resolved].filter(([src, url]) => url && url !== src));
      const size = 2 * (text.length + [...images].reduce((total, [src, url]) => total + src.length + url.length, 0));
      if (!images.size || images.size > 128 || size > 32 * 1024 * 1024) return;
      entries.set(key, { text, images, bytes: size });
      bytes += size;
      count += images.size;
      while (bytes > 32 * 1024 * 1024 || count > 128) remove(entries.keys().next().value!);
    },
  };
}

export const HistoryImageCacheKey: InjectionKey<ReturnType<typeof createHistoryImageCache>> = Symbol('history-images');
