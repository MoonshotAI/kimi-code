import { existsSync } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fail, run, tryRun } from './exec.mjs';
import {
  appRoot,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  targetTriple,
} from './paths.mjs';

function kimiBuildPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    resolve(appRoot, 'packages/kimi-build/target/release/kimi-build' + ext),
    resolve(appRoot, 'packages/kimi-build/target/debug/kimi-build' + ext),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

async function ensureBlobExists() {
  try {
    await stat(nativeBlobPath());
  } catch {
    fail(`SEA blob not found at ${nativeBlobPath()}. Run 02-sea-blob.mjs first.`);
  }
}

async function copyNodeExecutable(target) {
  await mkdir(nativeBinDir(target), { recursive: true });
  const out = nativeBinPath(target);
  await copyFile(process.execPath, out);
  if (process.platform !== 'win32') {
    await run('chmod', ['755', out]);
  }
}

async function removeSignatureIfNeeded(target) {
  const out = nativeBinPath(target);
  if (process.platform === 'darwin') {
    await tryRun('codesign', ['--remove-signature', out]);
  }
  if (process.platform === 'win32') {
    await tryRun('signtool', ['remove', '/s', out]);
  }
}

async function injectSeaBlob(target) {
  const out = nativeBinPath(target);
  const kimiBuild = kimiBuildPath();
  if (!kimiBuild) {
    fail(
      'kimi-build not found. Build it first with: cd packages/kimi-build && cargo build --release',
    );
  }
  await run(kimiBuild, ['inject', out, nativeBlobPath(), '-o', out]);
}

export async function runInjectStep() {
  const target = targetTriple();
  await ensureBlobExists();
  await copyNodeExecutable(target);
  await removeSignatureIfNeeded(target);
  await injectSeaBlob(target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runInjectStep();
}
