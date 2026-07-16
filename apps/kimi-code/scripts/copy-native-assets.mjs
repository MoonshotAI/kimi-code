import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'packages/pi-tui/native');
const target = resolve(appRoot, 'native');

// pi-tui ships platform-specific native helpers:
// - darwin: Shift-modifier detection for Terminal.app Shift+Enter
// - win32:  enable ENABLE_VIRTUAL_TERMINAL_INPUT so Shift+Tab is distinguishable
// - linux:  no native helper needed (terminals handle key input natively)
const PLATFORMS = ['darwin', 'linux', 'win32'];

async function assertPrebuilds(platform) {
  const dir = resolve(source, platform, 'prebuilds');
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const platform of PLATFORMS) {
  const srcPrebuilds = await assertPrebuilds(platform);
  if (srcPrebuilds === null) continue;
  const dstPrebuilds = resolve(target, platform, 'prebuilds');
  await cp(srcPrebuilds, dstPrebuilds, { recursive: true });
}

console.log(`Copied pi-tui native prebuilds to ${target}`);
