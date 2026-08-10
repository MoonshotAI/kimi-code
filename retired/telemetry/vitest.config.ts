import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-telemetry',
    include: ['test/**/*.test.ts'],
  },
});
