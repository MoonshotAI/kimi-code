import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'kap-server',
    include: ['test/**/*.{test,e2e}.ts'],
    setupFiles: ['test/setup.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 15_000,
  },
});
