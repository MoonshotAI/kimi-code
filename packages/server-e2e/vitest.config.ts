import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Alias `@moonshot-ai/protocol` to its src so tests track source edits without
// requiring a rebuild — mirrors `packages/server/vitest.config.ts`.
export default defineConfig({
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
