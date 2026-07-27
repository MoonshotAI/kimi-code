import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kernel-file-lock',
    include: ['test/**/*.test.ts'],
  },
});
