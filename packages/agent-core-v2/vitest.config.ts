import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core-v2',
    tags: [{ name: 'smoke' }],
    include: ['test/**/*.{test,e2e,integration}.ts', 'src/human/test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
  },
});
