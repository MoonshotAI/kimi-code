import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants, zstdCompressSync } from 'node:zlib';

import { ZipFile } from 'yazl';

import { run } from './exec.mjs';
import { executableName, nativeArtifactsDir, nativeBinPath, targetTriple } from './paths.mjs';

const target = targetTriple();
const execName = executableName();
const sourceBinary = nativeBinPath(target);
const artifactsDir = nativeArtifactsDir();

// Flat-name archive for GH Release (GitHub Release assets do not support subdirectories).
const artifactName = `kimi-code-${target}.zip`;
const artifactPath = resolve(artifactsDir, artifactName);
const checksumPath = `${artifactPath}.sha256`;

const compressedPath = resolve(artifactsDir, `kimi-code-${target}.zst`);
const compressedChecksumPath = `${compressedPath}.sha256`;

const tarballPath = resolve(artifactsDir, `kimi-code-${target}.tar.gz`);
const tarballChecksumPath = `${tarballPath}.sha256`;

function fail(message) {
  console.error(message);
  process.exit(1);
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

try {
  await stat(sourceBinary);
} catch {
  fail(`Native executable not found at ${sourceBinary}. Run build:native:sea first.`);
}

await mkdir(artifactsDir, { recursive: true });

const zip = new ZipFile();
zip.addFile(sourceBinary, execName, { mode: 0o100755 });
zip.end();
await pipeline(zip.outputStream, createWriteStream(artifactPath));

const digest = await sha256(artifactPath);
await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);

const compressed = zstdCompressSync(await readFile(sourceBinary), {
  params: { [constants.ZSTD_c_compressionLevel]: 19 },
});
await writeFile(compressedPath, compressed);
const compressedDigest = await sha256(compressedPath);
await writeFile(compressedChecksumPath, `${compressedDigest}  ${basename(compressedPath)}\n`);

await run('tar', ['-C', dirname(sourceBinary), '-czf', tarballPath, execName]);
const tarballDigest = await sha256(tarballPath);
await writeFile(tarballChecksumPath, `${tarballDigest}  ${basename(tarballPath)}\n`);

console.log(`Wrote native artifact: ${artifactPath}`);
console.log(`Wrote artifact checksum: ${checksumPath}`);
console.log(`Wrote compressed artifact: ${compressedPath}`);
console.log(`Wrote artifact checksum: ${compressedChecksumPath}`);
console.log(`Wrote tarball artifact: ${tarballPath}`);
console.log(`Wrote artifact checksum: ${tarballChecksumPath}`);
