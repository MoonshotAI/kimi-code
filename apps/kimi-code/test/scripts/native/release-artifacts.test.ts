import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { inflateRawSync, zstdDecompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';

import { appRoot } from '../../../scripts/native/paths.mjs';

const execFileAsync = promisify(execFile);
const packageScript = resolve(appRoot, 'scripts/native/package.mjs');
const manifestScript = resolve(appRoot, 'scripts/native/produce-manifest.mjs');
const artifactsDir = resolve(appRoot, 'dist-native/artifacts');
const target = 'test-zip-artifact';
const executableName = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
const fakeBinary = resolve(appRoot, 'dist-native/bin', target, executableName);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function zipEntryNames(zipPath: string): readonly string[] {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function readZipEntry(zipPath: string, expectedName: string): Buffer {
  const zip = readFileSync(zipPath);
  const eocdOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < entryCount; i += 1) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (name === expectedName) {
      return readLocalEntry(zip, localHeaderOffset, method, compressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`zip entry not found: ${expectedName}`);
}

function readLocalEntry(
  zip: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  expect(zip.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
  const nameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported zip compression method: ${String(method)}`);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('end of central directory not found');
}

describe('native release artifacts', () => {
  afterEach(() => {
    rmSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true, force: true });
    for (const name of [
      `kimi-code-${target}.zip`,
      `kimi-code-${target}.zip.sha256`,
      `kimi-code-${target}.zst`,
      `kimi-code-${target}.zst.sha256`,
      `kimi-code-${target}.tar.gz`,
      `kimi-code-${target}.tar.gz.sha256`,
      'manifest.json',
    ]) {
      rmSync(resolve(artifactsDir, name), { force: true });
    }
  });

  it('packages the native binary as a zip archive and checksums the archive', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });

    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target },
    });

    const archivePath = resolve(artifactsDir, `kimi-code-${target}.zip`);
    const checksumPath = `${archivePath}.sha256`;
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(checksumPath)).toBe(true);
    expect(zipEntryNames(archivePath)).toEqual([executableName]);
    expect(readZipEntry(archivePath, executableName).toString('utf-8')).toBe(binaryContent);
    expect(readFileSync(checksumPath, 'utf-8')).toBe(
      `${sha256(readFileSync(archivePath))}  kimi-code-${target}.zip\n`,
    );
  });

  it('produces compressed artifacts and a manifest paired with the bare binary', async () => {
    const binaryContent = 'native binary payload\n';
    mkdirSync(resolve(appRoot, 'dist-native/bin', target), { recursive: true });
    writeFileSync(fakeBinary, binaryContent, { mode: 0o755 });
    await execFileAsync(process.execPath, [packageScript], {
      cwd: appRoot,
      env: { ...process.env, KIMI_CODE_BUILD_TARGET: target },
    });

    await execFileAsync(process.execPath, [manifestScript, artifactsDir, '@moonshot-ai/kimi-code@0.5.0']);

    const zstBytes = readFileSync(resolve(artifactsDir, `kimi-code-${target}.zst`));
    expect(zstdDecompressSync(zstBytes).toString('utf-8')).toBe(binaryContent);
    const tarballPath = resolve(artifactsDir, `kimi-code-${target}.tar.gz`);
    expect(existsSync(tarballPath)).toBe(true);
    expect(readFileSync(`${tarballPath}.sha256`, 'utf-8')).toBe(
      `${sha256(readFileSync(tarballPath))}  kimi-code-${target}.tar.gz\n`,
    );

    const manifest = JSON.parse(
      readFileSync(resolve(artifactsDir, 'manifest.json'), 'utf-8'),
    ) as {
      version: string;
      tag: string;
      platforms: Record<
        string,
        { filename: string; checksum: string; compressed: { filename: string; checksum: string } }
      >;
    };
    expect(manifest).toEqual({
      version: '0.5.0',
      tag: '@moonshot-ai/kimi-code@0.5.0',
      platforms: {
        [target]: {
          filename: `kimi-code-${target}`,
          checksum: sha256(Buffer.from(binaryContent)),
          compressed: { filename: `kimi-code-${target}.zst`, checksum: sha256(zstBytes) },
        },
      },
    });
  });

  it('keeps the .exe suffix in Windows manifest filenames', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-win32-'));
    try {
      const binaryContent = Buffer.from('fake windows binary');
      const zip = new ZipFile();
      zip.addBuffer(binaryContent, 'kimi.exe');
      zip.end();
      await pipeline(
        zip.outputStream,
        createWriteStream(join(releaseDir, 'kimi-code-win32-x64.zip')),
      );
      await writeFile(
        join(releaseDir, 'kimi-code-win32-x64.zip.sha256'),
        `${'b'.repeat(64)}  kimi-code-win32-x64.zip\n`,
      );

      await execFileAsync(process.execPath, [manifestScript, releaseDir, 'v0.5.0']);

      const manifest = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf-8')) as {
        platforms: Record<
          string,
          { filename: string; checksum: string; compressed: { filename: string } }
        >;
      };
      const entry = manifest.platforms['win32-x64'];
      if (entry === undefined) throw new Error('missing win32-x64 manifest entry');
      expect(entry.filename).toBe('kimi-code-win32-x64.exe');
      expect(entry.checksum).toBe(sha256(binaryContent));
      expect(entry.compressed.filename).toBe('kimi-code-win32-x64.zst');
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('fails when no zip sidecars exist', async () => {
    const releaseDir = await mkdtemp(join(tmpdir(), 'kimi-manifest-empty-'));
    try {
      await expect(
        execFileAsync(process.execPath, [manifestScript, releaseDir, 'v0.5.0']),
      ).rejects.toThrow();
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
});
