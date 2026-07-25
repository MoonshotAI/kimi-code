import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['napi-integration.test.ts', 'rust-loop.test.ts'],
  },
});
