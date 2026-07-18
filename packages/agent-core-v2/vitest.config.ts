import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core-v2',
    include: ['test/**/*.{test,e2e,integration}.ts'],
  },
});
