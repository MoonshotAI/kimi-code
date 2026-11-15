import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'session-import', include: ['test/**/*.test.ts'] },
});
