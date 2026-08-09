import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'webview-ui/src'),
      shared: resolve(import.meta.dirname, 'shared'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      // Force the Rust engine into stdio mode for in-process SDK tests: the
      // session/* RPC surface is stdio-only, and the napi bridge would
      // short-circuit it when the addon is present (see rust-loop.ts).
      KIMI_AGENT_FORCE_STDIO: '1',
      // Isolate the engine's persistent store (sessions.db) from the real
      // user home: tests use fixed session ids, and stale records from an
      // earlier run would leak work_dir/metadata state into fresh rigs.
      // The directory itself is materialized by test/setup-agent-home.ts.
      KIMI_AGENT_HOME: resolve(import.meta.dirname, 'test/.agent-home'),
    },
    setupFiles: ['test/setup-agent-home.ts'],
  },
});
