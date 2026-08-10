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
      // Isolate the engine's persistent store (sessions.db) from the real
      // user home: tests use fixed session ids, and stale records from an
      // earlier run would leak work_dir/metadata state into fresh rigs.
      // The directory itself is materialized by test/setup-agent-home.ts
      // (concurrent workers would otherwise race to create it).
      KIMI_AGENT_HOME: fileURLToPath(new URL('../../.tmp/agent-home-sdk', import.meta.url)),
    },
    setupFiles: ['test/setup-agent-home.ts'],
    include: ['test/**/*.test.ts'],
  },
});
