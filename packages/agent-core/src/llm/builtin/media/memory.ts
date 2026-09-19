import type { MediaUploadCache } from '#/llm/media/cache';
import type { MediaContent, MediaSource } from '#/llm/media/source';
import type { MediaStore } from '#/llm/media/store';
import type { MediaFileRef } from '#/llm/media/upload';

export interface MemoryMediaSource extends MediaSource {
  set(ref: string, content: MediaContent): void;
}

export function createMemoryMediaSource(
  entries?: Readonly<Record<string, MediaContent>>,
): MemoryMediaSource {
  const map = new Map<string, MediaContent>(Object.entries(entries ?? {}));
  return {
    get: (ref) => Promise.resolve(map.get(ref)),
    set: (ref, content) => {
      map.set(ref, content);
    },
  };
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMemoryMediaStore(): MediaStore {
  const map = new Map<string, MediaContent>();
  return {
    get: (ref) => Promise.resolve(map.get(ref)),
    put: async (content) => {
      const ref = await sha256BytesHex(content.bytes);
      map.set(ref, content);
      return ref;
    },
  };
}

export function createMemoryMediaUploadCache(): MediaUploadCache {
  const map = new Map<string, MediaFileRef>();
  return {
    get: (ref, providerKey) => Promise.resolve(map.get(`${ref}${providerKey}`)),
    put: (ref, providerKey, part) => {
      map.set(`${ref}${providerKey}`, part);
      return Promise.resolve();
    },
  };
}
