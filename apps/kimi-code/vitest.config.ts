import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const appRoot = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    env: {
      KIMI_LOG_LEVEL: 'off',
      // Keep credential tests hermetic: the OAuth toolkit now defaults to a
      // keychain-backed store via resolveTokenStorage. Force the file backend
      // so tests never read/write the developer's real OS keychain.
      KIMI_DISABLE_KEYRING: '1',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
