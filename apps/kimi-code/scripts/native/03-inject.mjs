import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { fail, run, tryRun } from './exec.mjs';
import {
  appRoot,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  SEA_SENTINEL_FUSE,
  targetTriple,
} from './paths.mjs';

function postjectPath() {
  const command = process.platform === 'win32' ? 'postject.cmd' : 'postject';
  return resolve(appRoot, 'node_modules/.bin', command);
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

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function signtoolPath() {
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';
  const binRoot = resolve(programFilesX86, 'Windows Kits/10/bin');
  const archDir = process.arch === 'arm64' ? 'arm64' : 'x64';
  let versions;
  try {
    versions = (await readdir(binRoot)).filter((entry) => entry.startsWith('10.'));
  } catch {
    return null;
  }
  versions.sort((a, b) => b.localeCompare(a));
  for (const version of versions) {
    const candidate = resolve(binRoot, version, archDir, 'signtool.exe');
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function removeSignatureIfNeeded(target) {
  const out = nativeBinPath(target);
  if (process.platform === 'darwin') {
    await tryRun('codesign', ['--remove-signature', out]);
  }
  if (process.platform === 'win32') {
    await tryRun((await signtoolPath()) ?? 'signtool', ['remove', '/s', out]);
  }
}

async function injectSeaBlob(target) {
  const out = nativeBinPath(target);
  const args = [out, 'NODE_SEA_BLOB', nativeBlobPath(), '--sentinel-fuse', SEA_SENTINEL_FUSE];
  if (process.platform === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  await run(postjectPath(), args);
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
