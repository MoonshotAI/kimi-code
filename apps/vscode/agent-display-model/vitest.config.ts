import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vscode-display-model',
    include: ['test/**/*.test.ts'],
  },
});
