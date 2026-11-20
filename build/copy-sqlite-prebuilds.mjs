import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const targets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

export async function copySqlitePrebuilds(outDir) {
  const requireFromAgentCore = createRequire(
    new URL('../packages/agent-core-v2/package.json', import.meta.url),
  );
  const packageEntry = requireFromAgentCore.resolve('better-sqlite3');
  const sourceDir = resolve(dirname(packageEntry), '../prebuilds');
  await mkdir(outDir, { recursive: true });
  for (const target of targets) {
    await cp(resolve(sourceDir, `${target}.node`), resolve(outDir, `${target}.node`));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    throw new Error('Usage: node build/copy-sqlite-prebuilds.mjs <outDir>');
  }
  await copySqlitePrebuilds(resolve(outDir));
}
