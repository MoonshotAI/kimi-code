import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is needed even for server-only tests because the server
// wires CoreProcessService → KimiCore, which drags in agent-core's
// `tools/builtin/*` tree that imports 20+ raw `.md` description files.
// Without the plugin those imports fail with "Failed to resolve import".
//
// Workspace `resolve.alias` mirrors `packages/services/vitest.config.ts:11` so
// tests run against src/index.ts (not built dist/) — keeps the feedback loop
// tight when adjacent packages change.
export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: [
      // Order matters — list MORE specific entries first so prefix matching
      // doesn't route them through the bare `@moonshot-ai/agent-core` alias
      // (which points at agent-core/src/index.ts, breaking subpath imports).
      {
        find: /^@moonshot-ai\/agent-core\/session\/store$/,
        replacement: fileURLToPath(
          new URL('../agent-core/src/session/store/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@moonshot-ai\/agent-core\/base\/common\/event$/,
        replacement: fileURLToPath(
          new URL('../agent-core/src/base/common/event.ts', import.meta.url),
        ),
      },
      {
        find: '@moonshot-ai/kimi-code-sdk',
        replacement: fileURLToPath(
          new URL('../node-sdk/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@moonshot-ai/agent-core',
        replacement: fileURLToPath(
          new URL('../agent-core/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@moonshot-ai/protocol',
        replacement: fileURLToPath(
          new URL('../protocol/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@moonshot-ai/kimi-code-oauth',
        replacement: fileURLToPath(
          new URL('../oauth/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: 'server',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
