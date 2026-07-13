import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is required because server-v2 pulls in agent-core-v2's full
// barrel, which imports `*.md?raw` prompt templates.
export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'kap-server',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
