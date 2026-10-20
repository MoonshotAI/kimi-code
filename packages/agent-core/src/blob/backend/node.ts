import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { errorCode } from '#/utils/error';

import type { BlobBackend } from '../backend';

export function nodeBlobBackend(dir: string): BlobBackend {
  const pathOf = (key: string): string => join(dir, ...key.split('/'));
  return {
    has: async (key) =>
      access(pathOf(key)).then(
        () => true,
        () => false,
      ),
    read: async (key) => {
      try {
        return new Uint8Array(await readFile(pathOf(key)));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
    write: async (key, data) => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, path);
    },
  };
}
