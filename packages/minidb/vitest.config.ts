import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'minidb',
    include: ['test/**/*.test.ts'],
    // Package safety floor: process-spawning e2e's and multi-thousand-op
    // tests legitimately need >5s (the vitest default) on shared CI runners
    // under shard parallelism. Per-test explicit timeouts still win over this.
    testTimeout: 30_000,
  },
});
