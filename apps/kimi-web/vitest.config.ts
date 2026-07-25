import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-web',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
