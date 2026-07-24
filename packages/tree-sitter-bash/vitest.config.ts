import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tree-sitter-bash',
    include: ['test/**/*.test.ts'],
  },
});
