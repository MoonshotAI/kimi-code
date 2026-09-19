import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@moonshot-ai/kimi-code-oauth/provider-credential',
        replacement: fileURLToPath(
          new URL('../oauth/src/provider-credential.ts', import.meta.url),
        ),
      },
      {
        find: '@moonshot-ai/kimi-code-oauth',
        replacement: fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
