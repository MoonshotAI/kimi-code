import { sha256Hex } from '#/utils/hash';

import type { BlobBackend } from './backend';

export interface BlobCache {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

const namespacePattern = /^[a-z0-9][a-z0-9-]*$/;

export function openBlobCache(backend: BlobBackend, namespace: string): BlobCache {
  if (!namespacePattern.test(namespace)) throw new TypeError(`Invalid blob cache namespace '${namespace}'`);
  const keyOf = async (key: string): Promise<string> =>
    `cache/${namespace}/${await sha256Hex(new TextEncoder().encode(key))}`;
  return {
    get: async (key) => {
      const data = await backend.read(await keyOf(key));
      return data === undefined ? undefined : (JSON.parse(new TextDecoder().decode(data)) as unknown);
    },
    put: async (key, value) => {
      await backend.write(await keyOf(key), new TextEncoder().encode(JSON.stringify(value)));
    },
  };
}
