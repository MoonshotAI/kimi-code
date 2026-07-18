import { execFile } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { fail, run, tryRun } from './exec.mjs';
import {
  appRoot,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  SEA_SENTINEL_FUSE,
  targetTriple,
} from './paths.mjs';

const execFileAsync = promisify(execFile);

function postjectPath() {
  const command = process.platform === 'win32' ? 'postject.cmd' : 'postject';
  return resolve(appRoot, 'node_modules/.bin', command);
}

function kimiBuildCandidates() {
  // Check for kimi-build in the packages/kimi-build directory
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [
    resolve(appRoot, 'packages/kimi-build/target/release/kimi-build' + ext),
    resolve(appRoot, 'packages/kimi-build/target/debug/kimi-build' + ext),
  ];
}

async function findKimiBuild() {
  // Check local build directories first
  for (const candidate of kimiBuildCandidates()) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  // Check if 'kimi-build' is on PATH
  try {
    await execFileAsync('kimi-build', ['--help'], { shell: true });
    return 'kimi-build';
  } catch {
    return null;
  }
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
  const kimiBuild = await findKimiBuild();

  if (kimiBuild) {
    // Use kimi-build (Rust) — no sentinel-fuse flag needed, it handles it internally.
    await run(kimiBuild, ['inject', out, nativeBlobPath(), '-o', out]);
  } else {
    // Fall back to postject (Node.js WASM)
    const args = [out, 'NODE_SEA_BLOB', nativeBlobPath(), '--sentinel-fuse', SEA_SENTINEL_FUSE];
    if (process.platform === 'darwin') {
      args.push('--macho-segment-name', 'NODE_SEA');
    }
    await run(postjectPath(), args);
  }
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
