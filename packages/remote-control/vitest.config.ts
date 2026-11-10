import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'remote-control',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
