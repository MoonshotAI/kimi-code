import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is required because importing `@moonshot-ai/kap-server` (for
// the v2 SDK tests) pulls in agent-core-v2's barrel, which imports `*.md?raw`
// prompt templates.
export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@moonshot-ai/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'server-e2e',
    include: ['test/**/*.test.ts'],
    reporters: ['default', './test/report/vitest-reporter.ts'],
  },
});
