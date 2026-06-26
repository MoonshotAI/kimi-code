import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

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
 * Resolve `#/` subpath imports the way Node's package.json `imports` field does,
 * but scoped to the importer's owning package so cross-package resolution works
 * in a monorepo (e.g. agent-core-v2 tests inlining kosong src: kosong's
 * `#/errors` resolves to `packages/kosong/src/errors.ts`, not agent-core-v2's).
 *
 * Tries `src/<sub>.ts` then `src/<sub>/index.ts`, mirroring the
 * `"#/*"` → `["./src/*.ts", "./src/<x>/index.ts"]` fallback used by the packages.
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

export default defineConfig({
  plugins: [hashImportsPlugin()],
  test: {
    name: 'agent-core-v2',
    include: ['test/**/*.{test,e2e,integration}.ts'],
  },
});
