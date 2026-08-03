import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'klient',
    include: ['test/**/*.test.ts'],
    reporters: ['default', './test/e2e/legacy/report/vitest-reporter.ts'],
    env: {
      // Rust-engine tests (rust transport suite) spawn the engine over stdio;
      // without this the napi singleton can lock and session/* RPCs return null.
      KIMI_AGENT_FORCE_STDIO: '1',
    },
  },
});
