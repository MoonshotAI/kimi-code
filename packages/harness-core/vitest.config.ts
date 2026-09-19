import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'harness-core',
    include: ['test/**/*.test.ts'],
  },
});
