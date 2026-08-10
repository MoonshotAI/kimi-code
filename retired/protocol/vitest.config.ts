import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'protocol',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
