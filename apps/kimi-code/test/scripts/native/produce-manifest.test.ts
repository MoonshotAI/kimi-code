import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';

const execFileAsync = promisify(execFile);
const scriptPath = resolve(import.meta.dirname, '../../../scripts/native/produce-manifest.mjs');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeZip(path: string, entryName: string, content: Buffer): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(content, entryName);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

describe('produce-manifest', () => {
  let inputDir: string;

  beforeEach(async () => {
    inputDir = await mkdtemp(join(tmpdir(), 'kimi-produce-manifest-'));
  });

  afterEach(async () => {
    await rm(inputDir, { recursive: true, force: true });
  });

  async function run(): Promise<any> {
    await execFileAsync(process.execPath, [scriptPath, inputDir, '@moonshot-ai/kimi-code@0.7.0']);
    return JSON.parse(await readFile(join(inputDir, 'manifest.json'), 'utf-8'));
  }

  it('extracts each zip, emits compressed artifacts, and pairs entries with the bare binary', async () => {
    const linuxBinary = Buffer.from(`fake-linux-binary-${'x'.repeat(4096)}`);
    const windowsBinary = Buffer.from(`fake-windows-binary-${'y'.repeat(2048)}`);
    await writeZip(join(inputDir, 'kimi-code-linux-x64.zip'), 'kimi', linuxBinary);
    await writeFile(
      join(inputDir, 'kimi-code-linux-x64.zip.sha256'),
      `${'a'.repeat(64)}  kimi-code-linux-x64.zip\n`,
    );
    await writeZip(join(inputDir, 'kimi-code-win32-x64.zip'), 'kimi.exe', windowsBinary);
    await writeFile(
      join(inputDir, 'kimi-code-win32-x64.zip.sha256'),
      `${'b'.repeat(64)}  kimi-code-win32-x64.zip\n`,
    );

    const manifest = await run();

    expect(manifest.version).toBe('0.7.0');
    expect(manifest.tag).toBe('@moonshot-ai/kimi-code@0.7.0');
    expect(manifest.platforms['linux-x64'].filename).toBe('kimi-code-linux-x64');
    expect(manifest.platforms['linux-x64'].checksum).toBe(sha256(linuxBinary));
    expect(manifest.platforms['win32-x64'].filename).toBe('kimi-code-win32-x64');
    expect(manifest.platforms['win32-x64'].checksum).toBe(sha256(windowsBinary));

    for (const [target, binary] of [
      ['linux-x64', linuxBinary],
      ['win32-x64', windowsBinary],
    ] as const) {
      const entry = manifest.platforms[target];
      expect(entry.compressed.filename).toBe(`kimi-code-${target}.zst`);
      const zstBytes = await readFile(join(inputDir, entry.compressed.filename));
      expect(zstdDecompressSync(zstBytes).equals(binary)).toBe(true);
      expect(entry.compressed.checksum).toBe(sha256(zstBytes));
      const tarballSidecar = await readFile(
        join(inputDir, `kimi-code-${target}.tar.gz.sha256`),
        'utf-8',
      );
      expect(tarballSidecar).toMatch(/^[0-9a-f]{64} {2}kimi-code-[a-z0-9-]+\.tar\.gz\n$/);
    }
  });

  it('fails when no zip sidecars exist', async () => {
    await expect(run()).rejects.toThrow();
  });
});
