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
  const target = basename(sumFile, '.sha256').replace(/^kimi-code-/, '').replace(/\.zip$/, '');
  const zipName = `kimi-code-${target}.zip`;
  const exeName = target.startsWith('win32') ? 'kimi.exe' : 'kimi';
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
