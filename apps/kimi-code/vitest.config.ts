import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
