import type { VideoURLPart } from '#/llm/message';
import type { BlobBackend } from '#/store/backend/backend';
import { sha256Hex } from '#/store/internal/blob';

const CACHE_PREFIX = 'media-upload';

export interface MediaUploadCache {
  get(ref: string, providerKey: string): Promise<VideoURLPart | undefined>;
  put(ref: string, providerKey: string, part: VideoURLPart): Promise<void>;
}

export function createMemoryMediaUploadCache(): MediaUploadCache {
  const map = new Map<string, VideoURLPart>();
  return {
    get: (ref, providerKey) => Promise.resolve(map.get(`${ref}${providerKey}`)),
    put: (ref, providerKey, part) => {
      map.set(`${ref}${providerKey}`, part);
      return Promise.resolve();
    },
  };
}

export function createBlobMediaUploadCache(blobs: BlobBackend): MediaUploadCache {
  const key = (ref: string, providerKey: string) =>
    sha256Hex(`${CACHE_PREFIX}${ref}${providerKey}`);
  return {
    get: async (ref, providerKey) => {
      const refKey = await key(ref, providerKey);
      if (!(await blobs.has(refKey))) return undefined;
      const raw = await blobs.read(refKey).catch(() => undefined);
      if (raw === undefined) return undefined;
      return parseCachedPart(raw);
    },
    put: async (ref, providerKey, part) => {
      const refKey = await key(ref, providerKey);
      await blobs.write(refKey, JSON.stringify(part.videoUrl)).catch(() => undefined);
    },
  };
}

function parseCachedPart(raw: string): VideoURLPart | undefined {
  try {
    const data = JSON.parse(raw) as { url?: unknown; id?: unknown };
    if (typeof data.url !== 'string' || data.url.length === 0) return undefined;
    return {
      type: 'video_url',
      videoUrl: { url: data.url, id: typeof data.id === 'string' ? data.id : undefined },
    };
  } catch {
    return undefined;
  }
}
