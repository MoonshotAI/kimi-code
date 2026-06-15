import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'migration-legacy',
    include: ['test/**/*.test.ts'],
  },
});
