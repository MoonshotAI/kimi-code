import type { MediaContent, MediaSource } from './source';

export interface MediaStore extends MediaSource {
  put(content: MediaContent): Promise<string>;
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
