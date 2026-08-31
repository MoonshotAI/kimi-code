import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve(import.meta.dirname, '../../../scripts/native/produce-manifest.mjs');

describe('produce-manifest', () => {
  let inputDir: string;

  beforeEach(async () => {
    inputDir = await mkdtemp(join(tmpdir(), 'kimi-produce-manifest-'));
  });

  afterEach(async () => {
    await rm(inputDir, { recursive: true, force: true });
  });

  async function run(): Promise<any> {
    await execFileAsync(process.execPath, [scriptPath, inputDir, 'v0.7.0']);
    return JSON.parse(await readFile(join(inputDir, 'manifest.json'), 'utf-8'));
  }

  it('adds a compressed entry for platforms with a .zst sidecar', async () => {
    await writeFile(
      join(inputDir, 'kimi-code-linux-x64.zip.sha256'),
      `${'a'.repeat(64)}  kimi-code-linux-x64.zip\n`,
    );
    await writeFile(
      join(inputDir, 'kimi-code-linux-x64.zst.sha256'),
      `${'b'.repeat(64)}  kimi-code-linux-x64.zst\n`,
    );
    // A platform without a .zst sidecar keeps the bare-only entry.
    await writeFile(
      join(inputDir, 'kimi-code-darwin-arm64.zip.sha256'),
      `${'c'.repeat(64)}  kimi-code-darwin-arm64.zip\n`,
    );

    const manifest = await run();

    expect(manifest.version).toBe('0.7.0');
    expect(manifest.platforms['linux-x64']).toEqual({
      filename: 'kimi-code-linux-x64.zip',
      checksum: 'a'.repeat(64),
      compressed: { filename: 'kimi-code-linux-x64.zst', checksum: 'b'.repeat(64) },
    });
    expect(manifest.platforms['darwin-arm64']).toEqual({
      filename: 'kimi-code-darwin-arm64.zip',
      checksum: 'c'.repeat(64),
    });
  });

  it('produces the previous output shape when no .zst sidecars exist', async () => {
    await writeFile(
      join(inputDir, 'kimi-code-linux-x64.zip.sha256'),
      `${'a'.repeat(64)}  kimi-code-linux-x64.zip\n`,
    );

    const manifest = await run();

    expect(manifest).toEqual({
      version: '0.7.0',
      tag: 'v0.7.0',
      platforms: {
        'linux-x64': { filename: 'kimi-code-linux-x64.zip', checksum: 'a'.repeat(64) },
      },
    });
  });
});
