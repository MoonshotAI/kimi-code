import { watch as fsWatch } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { ConfigPersist } from './store';

export function createTomlConfigPersist(path: string): ConfigPersist {
  return {
    load: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    save: async (text) => {
      const tmp = `${path}.tmp-${String(process.pid)}`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
    },
    watch: (onChange) => {
      const watcher = fsWatch(dirname(path), (_event, name) => {
        if (name === basename(path)) {
          onChange();
        }
      });
      return () => {
        watcher.close();
      };
    },
  };
}
