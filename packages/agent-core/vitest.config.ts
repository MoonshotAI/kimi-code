import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
  },
});
