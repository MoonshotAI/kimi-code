import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
  const repoRoot = resolve(appRoot, '..', '..');
  const candidates = [
    resolve(repoRoot, 'packages/kimi-build/target/release/kimi-build' + ext),
    resolve(repoRoot, 'packages/kimi-build/target/debug/kimi-build' + ext),
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

// Locate postject's CommonJS api.js. postject is the reference SEA injector:
// unlike `objcopy --add-section`, it adds a proper loadable segment so Node
// can read the blob from memory at runtime. Plain objcopy leaves the section
// unmapped, which makes Node null-deref (SIGSEGV) on startup.
function findPostjectApi() {
  const repoRoot = resolve(appRoot, '..', '..');
  const hoisted = resolve(repoRoot, 'node_modules/postject/dist/api.js');
  if (existsSync(hoisted)) return hoisted;
  const pnpmDir = resolve(repoRoot, 'node_modules/.pnpm');
  try {
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('postject@'));
    if (entry) {
      const nested = resolve(pnpmDir, entry, 'node_modules/postject/dist/api.js');
      if (existsSync(nested)) return nested;
    }
  } catch { /* ignore */ }
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

  // Prefer postject (reference injector) — it adds a proper loadable segment
  // for the NODE_SEA_BLOB and flips the sentinel fuse. The kimi-build ELF path
  // uses `objcopy --add-section`, which cannot add a loadable segment, so Node
  // reads an unmapped blob and crashes (SIGSEGV, "segfault at 0").
  const postjectApi = findPostjectApi();
  if (postjectApi) {
    const nodeBytes = await readFile(out);
    const match = nodeBytes.toString('latin1').match(/NODE_SEA_FUSE_[0-9a-f]+/);
    if (!match) {
      fail(`Could not find a NODE_SEA_FUSE sentinel in ${out}. Is this a SEA-enabled Node?`);
    }
    const sentinelFuse = match[0];
    const require = createRequire(import.meta.url);
    const { inject } = require(postjectApi);
    const blob = await readFile(nativeBlobPath());
    await inject(out, 'NODE_SEA_BLOB', blob, { sentinelFuse });
    console.log(
      `Injected NODE_SEA_BLOB via postject (${blob.length} bytes, fuse ${sentinelFuse})`,
    );
    return;
  }

  // Fallback: kimi-build injector.
  const kimiBuild = kimiBuildPath();
  if (!kimiBuild) {
    fail(
      'No SEA injector available. Install postject or build kimi-build: cd packages/kimi-build && cargo build --release',
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
