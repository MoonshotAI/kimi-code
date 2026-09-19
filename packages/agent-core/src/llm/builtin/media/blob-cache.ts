import { sha256Hex, type BlobBackend } from '#/store/blob';

import type { MediaUploadCache } from '#/llm/media/cache';
import type { MediaFileRef } from '#/llm/media/upload';

const CACHE_PREFIX = 'media-upload';

export function createBlobMediaUploadCache(blobs: BlobBackend): MediaUploadCache {
  const key = (ref: string, providerKey: string) =>
    sha256Hex(new TextEncoder().encode(`${CACHE_PREFIX}${ref}${providerKey}`));
  return {
    get: async (ref, providerKey) => {
      const refKey = await key(ref, providerKey);
      if (!(await blobs.has(refKey))) return undefined;
      const raw = await blobs.read(refKey).catch(() => undefined);
      if (raw === undefined) return undefined;
      return parseCachedPart(new TextDecoder().decode(raw));
    },
    put: async (ref, providerKey, part) => {
      const refKey = await key(ref, providerKey);
      await blobs.write(refKey, new TextEncoder().encode(JSON.stringify(part))).catch(() => undefined);
    },
  };
}

function parseCachedPart(raw: string): MediaFileRef | undefined {
  try {
    const data = JSON.parse(raw) as { url?: unknown; id?: unknown };
    if (typeof data.url !== 'string' || data.url.length === 0) return undefined;
    return {
      url: data.url,
      id: typeof data.id === 'string' ? data.id : undefined,
    };
  } catch {
    return undefined;
  }
}
