import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'kap-server-bench',
    include: ['test/**/*.bench.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
