import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { run } from './exec.mjs';
import { resolveExecutableFileRelatives } from './native-deps.mjs';
import { nativeBinDir, nativeBinPath, targetTriple } from './paths.mjs';

const ENTITLEMENTS_PATH = resolve(import.meta.dirname, 'entitlements.plist');

export function buildCodesignArgs({ identity, executable, entitlementsPath, keychainPath }) {
  if (identity === '-') {
    return ['--sign', '-', executable];
  }
  const args = [
    '--sign',
    identity,
    '--options',
    'runtime',
    '--entitlements',
    entitlementsPath,
    '--timestamp',
  ];
  if (keychainPath) {
    args.push('--keychain', keychainPath);
  }
  args.push('--force', executable);
  return args;
}

export function buildCodesignNativeHelperArgs({ identity, file, keychainPath }) {
  if (identity === '-') {
    return ['--sign', '-', file];
  }
  const args = ['--sign', identity, '--options', 'runtime', '--timestamp'];
  if (keychainPath) {
    args.push('--keychain', keychainPath);
  }
  args.push('--force', file);
  return args;
}

async function sha256(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function writeChecksum(executable) {
  const digest = await sha256(executable);
  await writeFile(`${executable}.sha256`, `${digest}  ${basename(executable)}\n`);
}

export async function runSignStep({ identity = '-', keychainPath = null } = {}) {
  const target = targetTriple();
  const executable = nativeBinPath(target);

  if (process.platform === 'darwin') {
    for (const relativePath of resolveExecutableFileRelatives(target)) {
      const file = resolve(nativeBinDir(target), relativePath);
      await stat(file);
      await run(
        'codesign',
        buildCodesignNativeHelperArgs({
          identity,
          file,
          keychainPath,
        }),
      );
    }

    const args = buildCodesignArgs({
      identity,
      executable,
      entitlementsPath: ENTITLEMENTS_PATH,
      keychainPath,
    });
    await run('codesign', args);
  }

  await writeChecksum(executable);
  console.log(`Signed and hashed: ${executable}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const identity = process.env.APPLE_SIGNING_IDENTITY ?? '-';
  const keychainPath = process.env.APPLE_KEYCHAIN_PATH ?? null;
  await runSignStep({ identity, keychainPath });
}
