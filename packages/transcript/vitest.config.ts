import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'transcript',
    include: ['test/**/*.test.ts'],
  },
});
