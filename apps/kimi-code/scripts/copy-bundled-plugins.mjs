import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'plugins', 'official');
const target = resolve(appRoot, 'bundled-plugins');

// The built-in capability wiring plugins ship inside the client release (see
// packages/agent-core-v2/src/app/capability/bundledPlugins.ts). Only the two
// capability entries are bundled — other official plugins stay marketplace
// catalog entries.
const PLUGIN_IDS = ['kimi-cu', 'kimi-webbridge'];

async function assertPluginDir(id) {
  const dir = resolve(source, id);
  const manifest = resolve(dir, 'kimi.plugin.json');
  try {
    const info = await stat(manifest);
    if (!info.isFile()) {
      throw new Error('not a file');
    }
  } catch {
    throw new Error(`Bundled plugin manifest was not found at ${manifest}.`);
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const id of PLUGIN_IDS) {
  const srcDir = await assertPluginDir(id);
  await cp(srcDir, resolve(target, id), { recursive: true });
}

console.log(`Copied bundled capability plugins (${PLUGIN_IDS.join(', ')}) to ${target}`);
