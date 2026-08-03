import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@moonshot-ai/kimi-code-oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
      // The session/* RPC surface (sessionCreate, sessionPrompt, cron, ...) is
      // stdio-only. Without this, the module-level engine singleton latches
      // onto the in-process napi addon on first use and every session call
      // degrades to null ("Rust engine unavailable"). Force stdio for tests.
      KIMI_AGENT_FORCE_STDIO: '1',
    },
    include: ['test/**/*.test.ts'],
  },
});
