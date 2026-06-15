import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ZipFile } from 'yazl';

import {
  executableName,
  nativeArtifactsDir,
  nativeBinDir,
  nativeBinPath,
  targetTriple,
} from './paths.mjs';

const target = targetTriple();
const execName = executableName();
const sourceBinary = nativeBinPath(target);
const artifactsDir = nativeArtifactsDir();

// Flat-name archive for GH Release (GitHub Release assets do not support subdirectories).
const artifactName = `kimi-code-${target}.zip`;
const artifactPath = resolve(artifactsDir, artifactName);
const checksumPath = `${artifactPath}.sha256`;

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

function toPosixPath(path) {
  return path.split('\\').join('/');
}

async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

try {
  await stat(sourceBinary);
} catch {
  fail(`Native executable not found at ${sourceBinary}. Run build:native:sea first.`);
}

await mkdir(artifactsDir, { recursive: true });

const zip = new ZipFile();
zip.addFile(sourceBinary, execName, { mode: 0o100755 });
for (const file of await listFiles(resolve(nativeBinDir(target), 'native'))) {
  zip.addFile(file, toPosixPath(relative(nativeBinDir(target), file)));
}
zip.end();
await pipeline(zip.outputStream, createWriteStream(artifactPath));

const digest = await sha256(artifactPath);
await writeFile(checksumPath, `${digest}  ${basename(artifactPath)}\n`);

console.log(`Wrote native artifact: ${artifactPath}`);
console.log(`Wrote artifact checksum: ${checksumPath}`);
