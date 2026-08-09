import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'klient',
    include: ['test/**/*.test.ts'],
    reporters: ['default', './test/e2e/legacy/report/vitest-reporter.ts'],
  },
});
