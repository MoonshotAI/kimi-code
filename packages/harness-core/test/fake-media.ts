import { createMemoryRefStore, type StoredContent } from '@moonshot-ai/agent-core';

import { buildMediaRefUrl, parseMediaRefUrl } from '#/features/media/ref';
import type { MediaStore } from '#/features/media/store';

export function createMemoryMediaStore(
  entries?: Readonly<Record<string, StoredContent>>,
): MediaStore {
  const map = new Map<string, StoredContent>(
    Object.entries(entries ?? {}).map(([key, value]) => [parseMediaRefUrl(key) ?? key, value]),
  );
  const hashes = createMemoryRefStore();
  return {
    get: (ref) => Promise.resolve(map.get(parseMediaRefUrl(ref) ?? ref)),
    put: async (content) => {
      const sha = await hashes.put(content);
      map.set(sha, content);
      return buildMediaRefUrl(sha);
    },
  };
}
