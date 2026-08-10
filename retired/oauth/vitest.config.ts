import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-oauth',
    include: ['test/**/*.test.ts'],
  },
});
