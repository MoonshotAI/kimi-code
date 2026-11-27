import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'testkit',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
