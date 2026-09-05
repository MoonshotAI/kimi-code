/**
 * Build the per-release native artifact set and `manifest.json` from the
 * matrix runners' zip archives.
 *
 * Usage:
 *   node produce-manifest.mjs <input-dir> <release-tag>
 *
 * Input dir must contain files matching: kimi-code-<target>.zip(.sha256)
 * (produced by package.mjs across the 6 native-build matrix runners). The
 * zip is the only form in which binaries leave the matrix runners, so this
 * script extracts each bare executable and emits next to it:
 *   kimi-code-<target>.zst       zstd -19, consumed by the staged updater
 *   kimi-code-<target>.tar.gz    consumed by install.sh / install.ps1
 *   <artifact>.sha256            sidecars in `<hex>  <name>` format
 *   manifest.json                platform entries pair the bare binary with
 *                                its compressed variant (`checksum` is always
 *                                the hash of what `compressed` inflates to)
 *
 * Requires `unzip`, `zstd`, and `tar` on PATH (preinstalled on
 * GitHub-hosted runners).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fail, run } from './exec.mjs';

const execFileAsync = promisify(execFile);

const [, , inputDir, tag] = process.argv;
if (!inputDir || !tag) {
  console.error('Usage: produce-manifest.mjs <input-dir> <release-tag>');
  process.exit(1);
}

// Tag 格式 `@moonshot-ai/kimi-code@x.y.z` 或 `vx.y.z` 或 `x.y.z`，都归一化到 x.y.z
const version = tag.replace(/^@moonshot-ai\/kimi-code@/, '').replace(/^v/, '');

for (const tool of ['unzip', 'zstd', 'tar']) {
  try {
    await execFileAsync('sh', ['-c', `command -v ${tool}`]);
  } catch {
    fail(`produce-manifest.mjs requires \`${tool}\` on PATH (preinstalled on GitHub-hosted runners).`);
  }
}

async function sha256File(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

const entries = await readdir(inputDir);
const sumFiles = entries.filter((f) => /^kimi-code-[a-z0-9-]+\.zip\.sha256$/.test(f));
if (sumFiles.length === 0) {
  fail(`No kimi-code-<target>.zip.sha256 files found in ${inputDir}`);
}

const platforms = {};
for (const sumFile of sumFiles.sort()) {
  // kimi-code-darwin-arm64.zip.sha256 → darwin-arm64
  const target = basename(sumFile, '.sha256').replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  const zipName = `kimi-code-${target}.zip`;
  const exeName = target.startsWith('win32') ? 'kimi.exe' : 'kimi';
  // The CDN bare-binary layout carries the .exe suffix on Windows
  // (src/constant/app.ts); the updater's fallback downloads this filename.
  const binaryName = target.startsWith('win32') ? `kimi-code-${target}.exe` : `kimi-code-${target}`;
  const artifactBase = `kimi-code-${target}`;
  const zstName = `${artifactBase}.zst`;
  const tarballName = `${artifactBase}.tar.gz`;

  const workDir = await mkdtemp(join(tmpdir(), `native-manifest-${target}-`));
  try {
    await run('unzip', ['-o', resolve(inputDir, zipName), '-d', workDir]);
    const exePath = join(workDir, exeName);
    const binaryChecksum = await sha256File(exePath);
    await run('zstd', ['-T0', '-19', '-q', '-f', '-o', resolve(inputDir, zstName), exePath]);
    await run('tar', ['-C', workDir, '-czf', resolve(inputDir, tarballName), exeName]);

    const zstChecksum = await sha256File(resolve(inputDir, zstName));
    const tarballChecksum = await sha256File(resolve(inputDir, tarballName));
    await writeFile(resolve(inputDir, `${zstName}.sha256`), `${zstChecksum}  ${zstName}\n`);
    await writeFile(resolve(inputDir, `${tarballName}.sha256`), `${tarballChecksum}  ${tarballName}\n`);

    platforms[target] = {
      filename: binaryName,
      checksum: binaryChecksum,
      compressed: { filename: zstName, checksum: zstChecksum },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const manifest = { version, tag, platforms };
const manifestPath = resolve(inputDir, 'manifest.json');

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${manifestPath} (${Object.keys(platforms).length} platforms)`);
