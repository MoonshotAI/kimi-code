import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@moonshot-ai/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      '@moonshot-ai/kimi-code-oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
      // Keep credential tests hermetic: the OAuth toolkit now defaults to a
      // keychain-backed store via resolveTokenStorage, and the oauth source
      // alias resolves the native @napi-rs/keyring binary. Force the file
      // backend so tests never read/write the developer's real OS keychain.
      KIMI_DISABLE_KEYRING: '1',
    },
    include: ['test/**/*.test.ts'],
  },
});
