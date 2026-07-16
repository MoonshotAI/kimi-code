// apps/kimi-vscode/scripts/prepare-runtime.mjs
// Stage the self-contained server runtime into apps/kimi-vscode/server/ so
// `vsce package` can ship it (the directory is gitignored):
//
//   server/main.cjs      — the CLI's single-file bundle from
//                          apps/kimi-code's `build:native:js`
//                          (dist-native/intermediates/main.cjs). It contains
//                          the whole server incl. agent-core-v2; no node_modules
//                          are needed at runtime.
//   server/package.json  — host-root marker: the CLI walks up from the bundle
//                          for a package.json (host package root + version).
//   server/dist-web/     — the built web UI (apps/kimi-code/dist-web), served
//                          by the server from `<host-root>/dist-web`.
//
// Prereqs (the CI workflow runs all three; locally, once per change):
//   pnpm --filter @moonshot-ai/kimi-web run build
//   node apps/kimi-code/scripts/copy-web-assets.mjs
//   pnpm --filter @moonshot-ai/kimi-code run build:native:js

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(extRoot, '..', '..');
const bundlePath = join(repoRoot, 'apps', 'kimi-code', 'dist-native', 'intermediates', 'main.cjs');
const distWebDir = join(repoRoot, 'apps', 'kimi-code', 'dist-web');
const cliPkgPath = join(repoRoot, 'apps', 'kimi-code', 'package.json');

function assertExists(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — ${hint}`);
  }
}

assertExists(bundlePath, 'run `pnpm --filter @moonshot-ai/kimi-code run build:native:js` first');
assertExists(distWebDir, 'run `node apps/kimi-code/scripts/copy-web-assets.mjs` first');

const cliPkg = JSON.parse(await readFile(cliPkgPath, 'utf-8'));

const outDir = join(extRoot, 'server');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(bundlePath, join(outDir, 'main.cjs'));
await cp(distWebDir, join(outDir, 'dist-web'), { recursive: true });
await writeFile(
  join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'kimi-vscode-server', private: true, version: cliPkg.version }, null, 2)}\n`,
  'utf-8',
);

console.log(`staged server runtime (CLI ${cliPkg.version}) -> ${outDir}`);
