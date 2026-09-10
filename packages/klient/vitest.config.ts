import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'klient',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    reporters: ['default', './test/e2e/legacy/report/vitest-reporter.ts'],
  },
});
