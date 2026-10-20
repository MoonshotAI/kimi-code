import type { BlobBackend } from '../backend';

export function memoryBlobBackend(entries: Map<string, Uint8Array> = new Map()): BlobBackend {
  return {
    has: async (key) => entries.has(key),
    read: async (key) => entries.get(key),
    write: async (key, data) => {
      entries.set(key, data);
    },
  };
}
