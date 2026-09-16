import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'remote-exec',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
