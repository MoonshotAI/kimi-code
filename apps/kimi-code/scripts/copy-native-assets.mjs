import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { copySqlitePrebuilds } from '../../../build/copy-sqlite-prebuilds.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'packages/pi-tui/native');
const target = resolve(appRoot, 'native');

// pi-tui ships platform-specific native helpers for darwin/linux/win32.
const PLATFORMS = ['darwin', 'linux', 'win32'];

async function assertPrebuilds(platform) {
  const dir = resolve(source, platform, 'prebuilds');
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error(
      `pi-tui native prebuilds were not found at ${dir}. Build or restore packages/pi-tui first.`,
    );
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const platform of PLATFORMS) {
  const srcPrebuilds = await assertPrebuilds(platform);
  const dstPrebuilds = resolve(target, platform, 'prebuilds');
  await cp(srcPrebuilds, dstPrebuilds, { recursive: true });
}

await copySqlitePrebuilds(resolve(appRoot, 'dist', 'better-sqlite3'));

console.log(`Copied pi-tui and SQLite native prebuilds to ${target} and ${appRoot}/dist/better-sqlite3`);
