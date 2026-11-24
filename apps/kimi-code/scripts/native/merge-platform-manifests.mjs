import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUPPORTED_TARGETS } from './native-deps.mjs';

const [, , dir, tag] = process.argv;
if (!dir || !tag) throw new Error('Expected an artifact directory and CLI release tag');
const version = tag.replace(/^@moonshot-ai\/kimi-code@/, '');
const platforms = {};
for (const target of SUPPORTED_TARGETS) {
  const fragment = JSON.parse(await readFile(join(dir, `manifest-${target}.json`), 'utf8'));
  if (fragment.tag !== tag || fragment.version !== version || Object.keys(fragment.platforms).length !== 1 || !fragment.platforms[target]) {
    throw new Error(`Unexpected native manifest for ${target} at ${tag}`);
  }
  platforms[target] = fragment.platforms[target];
}
await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ version, tag, platforms }, null, 2)}\n`);
