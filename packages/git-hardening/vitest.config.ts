import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'git-hardening',
    include: ['test/**/*.test.ts'],
  },
});
