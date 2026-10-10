import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'exec-policy',
    include: ['test/**/*.test.ts'],
  },
});
