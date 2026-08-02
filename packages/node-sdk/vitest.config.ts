import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Longer subpath keys MUST precede the bare entry alias (vite resolves
      // in order with prefix matching).
      '@moonshot-ai/agent-core/mcp/config-loader': fileURLToPath(
        new URL('../agent-core/src/mcp/config-loader.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core/config/schema': fileURLToPath(
        new URL('../agent-core/src/config/schema.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core/plugin/manager': fileURLToPath(
        new URL('../agent-core/src/plugin/manager.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core/profile/context': fileURLToPath(
        new URL('../agent-core/src/profile/context.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core/profile/default': fileURLToPath(
        new URL('../agent-core/src/profile/default.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core': fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      '@moonshot-ai/kimi-code-oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
  },
});
