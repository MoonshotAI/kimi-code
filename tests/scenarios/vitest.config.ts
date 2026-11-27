import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'scenarios',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    setupFiles: ['./support/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
