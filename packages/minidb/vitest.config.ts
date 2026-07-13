import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'minidb',
    include: ['test/**/*.test.ts'],
  },
});
