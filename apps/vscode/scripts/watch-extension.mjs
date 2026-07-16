#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

import { runLocalCli } from './local-cli.mjs';
import { extensionRoot, isMainModule } from './vsix-targets.mjs';

const sourceDirectories = [
  join(extensionRoot, 'src'),
  join(extensionRoot, 'shared'),
  ...[
    'agent-core',
    'kaos',
    'kosong',
    'migration-legacy',
    'node-sdk',
    'oauth',
    'protocol',
    'telemetry',
  ].map((name) => resolve(extensionRoot, `../../packages/${name}/src`)),
].filter(existsSync);
const rootConfigFiles = ['package.json', 'tsconfig.json', 'tsdown.config.ts'].map((name) =>
  join(extensionRoot, name),
);
const watchedExtensions = new Set(['.cts', '.js', '.json', '.md', '.mjs', '.mts', '.ts', '.tsx']);
const pollIntervalMs = 1_500;

function buildExtension() {
  runLocalCli(
    'tsdown',
    'tsdown',
    ['--config', join(extensionRoot, 'tsdown.config.ts'), '--sourcemap'],
    { cwd: extensionRoot },
  );
}

async function main() {
  buildExtension();
  let snapshot = await sourceSnapshot();
  let checking = false;
  const poll = async () => {
    if (checking) return;
    checking = true;
    try {
      const nextSnapshot = await sourceSnapshot();
      if (nextSnapshot === snapshot) return;
      snapshot = nextSnapshot;
      console.log('\nExtension source changed; rebuilding with sourcemaps...');
      buildExtension();
      console.log('Extension rebuild complete.');
    } catch (error) {
      console.error(`Extension watch check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      checking = false;
    }
  };
  const interval = setInterval(() => void poll(), pollIntervalMs);

  const close = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  console.log('Extension dev build complete; watching for changes.');
}

async function sourceSnapshot() {
  const records = [];
  for (const directory of sourceDirectories) await collectSourceRecords(directory, records);
  for (const file of rootConfigFiles) await addFileRecord(file, records);
  return records.sort().join('\n');
}

async function collectSourceRecords(directory, records) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSourceRecords(path, records);
    } else if (entry.isFile() && watchedExtensions.has(extname(entry.name))) {
      await addFileRecord(path, records);
    }
  }
}

async function addFileRecord(path, records) {
  const info = await stat(path);
  records.push(`${path}:${info.size}:${info.mtimeMs}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Extension watch failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
