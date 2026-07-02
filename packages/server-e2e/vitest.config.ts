import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

function findPackageRoot(importer: string | undefined): string | undefined {
  if (!importer) return undefined;
  let dir = dirname(importer.split('?')[0] ?? importer);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve `#/` subpath imports scoped to the importer's owning package. Required
 * because the v2 SDK tests import `@moonshot-ai/server-v2`, which inlines
 * `@moonshot-ai/agent-core-v2` source whose internal `#/foo` imports must
 * resolve against that package's own `src/`. Mirrors
 * `packages/server-v2/vitest.config.ts`.
 */
function hashImportsPlugin(): Plugin {
  return {
    name: 'resolve-hash-imports',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('#/')) return null;
      const pkgRoot = findPackageRoot(importer);
      if (!pkgRoot) return null;
      const sub = id.slice(2);
      for (const candidate of [`src/${sub}.ts`, `src/${sub}/index.ts`]) {
        const full = join(pkgRoot, candidate);
        if (existsSync(full)) return full;
      }
      return null;
    },
  };
}

// `rawTextPlugin` is required because importing `@moonshot-ai/server-v2` (for
// the v2 SDK tests) pulls in agent-core-v2's barrel, which imports `*.md?raw`
// prompt templates. Both plugins are no-ops for the legacy v1 tests, which do
// not import server-v2.
export default defineConfig({
  plugins: [rawTextPlugin(), hashImportsPlugin()],
  resolve: {
    alias: {
      '@moonshot-ai/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'server-e2e',
    include: ['test/**/*.test.ts'],
    reporters: ['default', './test/report/vitest-reporter.ts'],
  },
});
