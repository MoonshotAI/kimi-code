import { cp, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
// This branch ships the design-first kimi-web2 UI as the bundled web assets.
// kimi-web2 is a static, no-build app, so it is copied directly (no dist step).
const source = resolve(repoRoot, 'apps/kimi-web2');
const target = resolve(appRoot, 'dist-web');

// Dev/docs files that should not ship in the web asset bundle.
const EXCLUDE = new Set(['serve.mjs', 'README.md', 'CONVENTIONS.md']);

async function assertWebSource() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(`Kimi web assets were not found at ${source}.`);
  }
}

await assertWebSource();
await rm(target, { recursive: true, force: true });
await cp(source, target, {
  recursive: true,
  filter: (src) => !EXCLUDE.has(basename(src)),
});

console.log(`Copied Kimi web assets (kimi-web2) to ${target}`);
