import { mkdirSync, watch } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { ConfigPersist } from '@moonshot-ai/agent-core';

import { atomicWrite } from '#/utils/fs';

const WATCH_DEBOUNCE_MS = 150;

export function createTomlConfigPersist(configPath: string): ConfigPersist {
  return {
    load: async () => {
      try {
        return await readFile(configPath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    save: async (text) => {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await atomicWrite(configPath, text);
    },
    watch: (onChange) => {
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(dirname(configPath), (_event, filename) => {
        if (filename !== basename(configPath)) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          onChange();
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {});
      return () => {
        if (timer !== undefined) clearTimeout(timer);
        watcher.close();
      };
    },
  };
}
