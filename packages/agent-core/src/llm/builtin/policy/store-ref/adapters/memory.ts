import type { UploadedMedia } from '#/llm/request';

import { sha256Hex } from '../hash';
import type { RefStore, StoredContent, UploadCache } from '../ports';

export interface MemoryRefStore extends RefStore {
  put(content: StoredContent): Promise<string>;
}

export function createMemoryRefStore(entries?: Readonly<Record<string, StoredContent>>): MemoryRefStore {
  const map = new Map<string, StoredContent>(Object.entries(entries ?? {}));
  return {
    get: (ref) => Promise.resolve(map.get(ref)),
    put: async (content) => {
      const ref = await sha256Hex(content.bytes);
      map.set(ref, content);
      return ref;
    },
  };
}

export function createMemoryUploadCache(): UploadCache {
  const map = new Map<string, UploadedMedia>();
  return {
    get: (ref, accountKey) => Promise.resolve(map.get(`${ref}\0${accountKey}`)),
    put: (ref, accountKey, uploaded) => {
      map.set(`${ref}\0${accountKey}`, uploaded);
      return Promise.resolve();
    },
  };
}
