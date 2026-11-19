import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nativeBinaryUrl, nativeManifestUrl } from '#/cli/update/native-manifest';
import {
  promoteStagedUpdateToManual,
  readStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

const fsMocks = vi.hoisted(() => ({
  calls: [] as Array<{ readonly op: 'chmod' | 'rename'; readonly path: string; readonly dst?: string }>,
  shortWriteBudget: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (
      path: Parameters<typeof actual.chmod>[0],
      mode: Parameters<typeof actual.chmod>[1],
    ) => {
      fsMocks.calls.push({ op: 'chmod', path: String(path) });
      return actual.chmod(path, mode);
    },
    rename: async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      fsMocks.calls.push({ op: 'rename', path: String(src), dst: String(dst) });
      return actual.rename(src, dst);
    },
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode: Parameters<typeof actual.open>[2],
    ) => {
      const handle = await actual.open(path, flags, mode);
      if (fsMocks.shortWriteBudget <= 0) return handle;
      fsMocks.shortWriteBudget -= 1;
      let truncated = false;
      return {
        write: async (
          buffer: Buffer,
          offset?: number | null,
          length?: number | null,
          position?: number | null,
        ) => {
          const off = offset ?? 0;
          const len = length ?? buffer.length - off;
          const effectiveLen = !truncated && len > 1 ? Math.floor(len / 2) : len;
          truncated = true;
          const result = await handle.write(buffer, off, effectiveLen, position ?? null);
          return { bytesWritten: result.bytesWritten, buffer: result.buffer };
        },
        close: () => handle.close(),
      };
    },
  };
});

const VERSION = '0.7.0';
const PAYLOAD = Buffer.from('fake-sea-binary-payload');
const BINARY_FILENAME = 'kimi-code-linux-x64';
const COMPRESSED_FILENAME = 'kimi-code-linux-x64.zst';

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function agedOrphan(path: string, content: string | Buffer): Promise<void> {
  await writeFile(path, content);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(path, old, old);
}

interface MockCdnOptions {
  readonly version?: string;
  readonly payload: Buffer;
  readonly checksum?: string;
  readonly compressed?: {
    readonly payload: Buffer | null;
    readonly checksum?: string;
    readonly field?: 'compressed' | 'zstd';
  };
}

function mockCdnFetch(options: MockCdnOptions): typeof fetch {
  const version = options.version ?? VERSION;
  const platformEntry: Record<string, unknown> = {
    filename: BINARY_FILENAME,
    checksum: options.checksum ?? sha256Hex(options.payload),
  };
  if (options.compressed !== undefined) {
    const checksum =
      options.compressed.checksum ?? sha256Hex(options.compressed.payload ?? Buffer.alloc(0));
    if (options.compressed.field === 'zstd') {
      platformEntry['zstd'] = { file: COMPRESSED_FILENAME, sha256: checksum };
    } else {
      platformEntry['compressed'] = { filename: COMPRESSED_FILENAME, checksum };
    }
  }
  const manifestBody = JSON.stringify({
    version,
    tag: `v${version}`,
    platforms: {
      'linux-x64': platformEntry,
    },
  });
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === nativeManifestUrl(version)) {
      return { ok: true, status: 200, text: async () => manifestBody, body: null };
    }
    if (url === nativeBinaryUrl(version, BINARY_FILENAME)) {
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => '',
        headers: {
          get: (name: string): string | null =>
            name === 'content-length' ? String(options.payload.length) : null,
        },
        body: [options.payload],
      };
    }
    if (url === nativeBinaryUrl(version, COMPRESSED_FILENAME) && options.compressed?.payload) {
      const payload = options.compressed.payload;
      return {
        ok: true,
        status: 200,
        text: async (): Promise<string> => '',
        headers: {
          get: (name: string): string | null =>
            name === 'content-length' ? String(payload.length) : null,
        },
        body: [payload],
      };
    }
    return { ok: false, status: 404, text: async () => '', body: null };
  }) as unknown as typeof fetch;
}

describe('stageNativeUpdate', () => {
  let workDir: string;
  let exePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-stage-test-'));
    exePath = join(workDir, 'bin', 'kimi');
    fsMocks.calls.length = 0;
    fsMocks.shortWriteBudget = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workDir, { recursive: true, force: true });
  });

  it('downloads, verifies and records the staged metadata', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged).toMatchObject({
      version: VERSION,
      channel: 'stable',
      target: 'linux-x64',
      sha256: sha256Hex(PAYLOAD),
      exeSize: PAYLOAD.length,
    });
    expect(result.staged.exeFileName).toMatch(/^kimi-0\.7\.0\.\d+\.\d+\.\d+$/);

    const stagedOnDisk = await readStagedNativeUpdate(exePath);
    expect(stagedOnDisk).toEqual(result.staged);
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
    const leftovers = (await readdir(getNativeStagingDir(exePath))).filter((entry) =>
      entry.endsWith('.part'),
    );
    expect(leftovers).toEqual([]);
  });

  it.each(['compressed', 'zstd'] as const)('downloads the %s artifact and stages the decompressed binary', async (field) => {
    const fetchImpl = mockCdnFetch({
      payload: PAYLOAD,
      compressed: { payload: zstdCompressSync(PAYLOAD), field },
    });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(result.status).toBe('staged');
    expect(result.staged.sha256).toBe(sha256Hex(PAYLOAD));
    expect(result.staged.exeSize).toBe(PAYLOAD.length);
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, BINARY_FILENAME),
      expect.anything(),
    );
    const leftovers = (await readdir(getNativeStagingDir(exePath))).filter((entry) =>
      entry.endsWith('.part'),
    );
    expect(leftovers).toEqual([]);
  });

  it.each(['compressed', 'zstd'] as const)('falls back to the bare binary when the compressed artifact is missing (%s)', async (field) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = mockCdnFetch({
      payload: PAYLOAD,
      compressed: { payload: null, field },
    });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(result.status).toBe('staged');
    expect(fetchImpl).toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, BINARY_FILENAME),
      expect.anything(),
    );
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
  });

  it.each(['compressed', 'zstd'] as const)('falls back to the bare binary when the compressed artifact fails verification (%s)', async (field) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = mockCdnFetch({
      payload: PAYLOAD,
      compressed: { payload: zstdCompressSync(PAYLOAD), checksum: 'f'.repeat(64), field },
    });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(result.status).toBe('staged');
    expect(fetchImpl).toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, BINARY_FILENAME),
      expect.anything(),
    );
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
  });

  it.each(['compressed', 'zstd'] as const)('falls back to the bare binary when the decompressed content fails verification (%s)', async (field) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = mockCdnFetch({
      payload: PAYLOAD,
      compressed: { payload: zstdCompressSync(Buffer.from('other-content')), field },
    });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(result.status).toBe('staged');
    expect(result.staged.sha256).toBe(sha256Hex(PAYLOAD));
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
  });

  it('prefers zstd when both manifest formats are present', async () => {
    const compressedPayload = zstdCompressSync(PAYLOAD);
    const fetchImpl = mockCdnFetch({
      payload: PAYLOAD,
      compressed: { payload: compressedPayload, field: 'zstd' },
    });
    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response(JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': {
          filename: BINARY_FILENAME,
          checksum: sha256Hex(PAYLOAD),
          zstd: { file: COMPRESSED_FILENAME, sha256: sha256Hex(compressedPayload) },
          compressed: { filename: 'legacy.zst', checksum: 'a'.repeat(64) },
        },
      },
    })));

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });

    expect(await readFile(stagedExePath(exePath, result.staged))).toEqual(PAYLOAD);
    expect(fetchImpl).toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, COMPRESSED_FILENAME),
      expect.anything(),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, 'legacy.zst'),
      expect.anything(),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      nativeBinaryUrl(VERSION, BINARY_FILENAME),
      expect.anything(),
    );
  });

  it('marks the staged exe executable', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    const info = await stat(stagedExePath(exePath, result.staged));
    expect(info.mode & 0o111).not.toBe(0);
  });

  it('records the manual marker when the stage answers an explicit upgrade', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      manual: true,
    });
    expect(result.staged.manual).toBe(true);
    expect((await readStagedNativeUpdate(exePath))?.manual).toBe(true);
  });

  it('makes the download executable before publishing it at the staged name', async () => {
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    const stagedExe = stagedExePath(exePath, result.staged);
    const chmodCall = fsMocks.calls.find(
      (call) => call.op === 'chmod' && call.path.endsWith('.part'),
    );
    const publishCall = fsMocks.calls.find(
      (call) => call.op === 'rename' && call.dst === stagedExe,
    );
    if (chmodCall === undefined || publishCall === undefined) {
      throw new Error('expected chmod(.part) and rename(.part → staged) calls');
    }
    expect(publishCall.path).toBe(chmodCall.path);
    expect(fsMocks.calls.indexOf(chmodCall)).toBeLessThan(
      fsMocks.calls.indexOf(publishCall),
    );
  });

  it('reports download progress with the Content-Length total', async () => {
    const progress: Array<readonly [number, number | null]> = [];
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      onProgress: (downloaded, total) => {
        progress.push([downloaded, total]);
      },
    });
    expect(progress).toEqual([[PAYLOAD.length, PAYLOAD.length]]);
  });

  it('aborts a stalled download after the idle timeout', async () => {
    const manifestBody = JSON.stringify({
      version: VERSION,
      platforms: {
        'linux-x64': { filename: BINARY_FILENAME, checksum: 'a'.repeat(64) },
      },
    });
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === nativeManifestUrl(VERSION)) {
        return { ok: true, status: 200, text: async () => manifestBody, body: null };
      }
      if (url === nativeBinaryUrl(VERSION, BINARY_FILENAME)) {
        const signal = init?.signal;
        const body = (async function* (): AsyncGenerator<Buffer> {
          yield Buffer.from('first-chunk');
          await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            }, { once: true });
          });
        })();
        return {
          ok: true,
          status: 200,
          text: async (): Promise<string> => '',
          headers: { get: (): string | null => null },
          body,
        };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
        idleTimeoutMs: 50,
      }),
    ).rejects.toThrow(/stalled/);
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('short-circuits when the same version is already staged', async () => {
    const firstFetch = mockCdnFetch({ payload: PAYLOAD });
    await stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl: firstFetch });

    const secondFetch = mockCdnFetch({ payload: PAYLOAD });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: secondFetch,
    });

    expect(result.status).toBe('already-staged');
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it('promotes an auto-staged payload to manual when an explicit upgrade adopts it', async () => {
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      manual: true,
    });

    expect(result.status).toBe('already-staged');
    expect(result.staged.manual).toBe(true);
    expect((await readStagedNativeUpdate(exePath))?.manual).toBe(true);
  });

  it('records the switch intent and never adopts a stage without it for a channel switch', async () => {
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      manual: true,
    });

    const switchFetch = mockCdnFetch({ payload: PAYLOAD });
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: switchFetch,
      manual: true,
      intent: 'switch-channel',
    });

    expect(result.status).toBe('staged');
    expect(switchFetch).toHaveBeenCalled();
    expect((await readStagedNativeUpdate(exePath))?.intent).toBe('switch-channel');

    const repeat = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      manual: true,
      intent: 'switch-channel',
    });
    expect(repeat.status).toBe('already-staged');
  });

  it('persists the selected canary channel instead of inferring it from the version', async () => {
    const target = '2.3.3-canary.20261028012345-0123456';
    const result = await stageNativeUpdate({
      version: target,
      channel: 'canary',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: target, payload: PAYLOAD }),
      manual: true,
      intent: 'switch-channel',
    });

    expect(result.status).toBe('staged');
    expect(result.staged.channel).toBe('canary');
    expect((await readStagedNativeUpdate(exePath))?.channel).toBe('canary');
  });

  it('rejects an unconfirmed channel switch before downloading or writing a stage', async () => {
    const fetchImpl = mockCdnFetch({ payload: PAYLOAD });

    await expect(stageNativeUpdate({
      version: VERSION,
      channel: 'canary',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
      intent: 'switch-channel',
    })).rejects.toThrow(/manual confirmation/);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('does not adopt a same-version stage from a different channel', async () => {
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      manual: true,
    });
    const canaryFetch = mockCdnFetch({ payload: PAYLOAD });

    const result = await stageNativeUpdate({
      version: VERSION,
      channel: 'canary',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: canaryFetch,
      manual: true,
    });

    expect(result.status).toBe('staged');
    expect(canaryFetch).toHaveBeenCalled();
    expect(result.staged.channel).toBe('canary');
  });

  it('re-stages when the staged exe is corrupted at the same size', async () => {
    const first = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    await writeFile(stagedExePath(exePath, first.staged), Buffer.alloc(PAYLOAD.length));
    expect(await readStagedNativeUpdate(exePath)).not.toBeNull();

    const secondFetch = mockCdnFetch({ payload: PAYLOAD });
    const second = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: secondFetch,
    });

    expect(second.status).toBe('staged');
    expect(secondFetch).toHaveBeenCalled();
    expect(second.staged.exeFileName).not.toBe(first.staged.exeFileName);
    const repaired = await readFile(stagedExePath(exePath, second.staged));
    expect(repaired.equals(PAYLOAD)).toBe(true);
  });

  it('re-stages when the staged exe went missing', async () => {
    const first = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    await rm(stagedExePath(exePath, first.staged));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();

    const second = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(second.status).toBe('staged');
  });

  it('keeps the previous staged record when the superseding download fails', async () => {
    await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', payload: Buffer.from('old-payload') }),
    });

    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: mockCdnFetch({ payload: PAYLOAD, checksum: 'f'.repeat(64) }),
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect((await readStagedNativeUpdate(exePath))?.version).toBe('0.6.0');
  });

  it('throws on a checksum mismatch and cleans up leftovers', async () => {
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl: mockCdnFetch({ payload: PAYLOAD, checksum: 'f'.repeat(64) }),
      }),
    ).rejects.toThrow(/sha256 mismatch/);

    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('throws when the platform is missing from the manifest', async () => {
    await expect(
      stageNativeUpdate({
        version: VERSION,
        exePath,
        platform: 'win32',
        arch: 'arm64',
        fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
      }),
    ).rejects.toThrow(/win32-arm64 not found/);
  });

  it('rejects a traversal version before deriving any filesystem path', async () => {
    const fetchImpl = mockCdnFetch({ payload: PAYLOAD });
    await expect(
      stageNativeUpdate({
        version: 'x/../../kimi',
        exePath,
        platform: 'linux',
        arch: 'x64',
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid semver/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('supersedes a staged older version', async () => {
    const first = await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', payload: Buffer.from('old-payload') }),
    });

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    expect(result.status).toBe('staged');
    expect(result.staged.version).toBe(VERSION);
    await expect(
      stat(join(getNativeStagingDir(exePath), first.staged.exeFileName)),
    ).resolves.toBeDefined();
  });

  it('preserves the exe referenced by the current record during orphan cleanup', async () => {
    const first = await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', payload: Buffer.from('old-payload') }),
    });
    const oldExe = stagedExePath(exePath, first.staged);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldExe, old, old);

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');

    await expect(stat(oldExe)).resolves.toBeDefined();
  });

  it('cleans orphaned staging files before downloading, preserving live swap claims', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stagingDir, { recursive: true });
    await agedOrphan(join(stagingDir, 'kimi-9.9.9'), Buffer.from('orphan-exe'));
    await agedOrphan(join(stagingDir, 'kimi-9.9.9.part'), Buffer.from('partial'));
    const claimExe = 'kimi-8.8.8';
    await writeFile(join(stagingDir, claimExe), Buffer.from('swap-in-progress'));
    await writeFile(
      join(stagingDir, 'staged.json.swap-1234'),
      JSON.stringify({ exeFileName: claimExe }),
    );
    const youngExe = 'kimi-7.7.7';
    await writeFile(join(stagingDir, youngExe), Buffer.from('just-published'));

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');

    await expect(stat(join(stagingDir, 'kimi-9.9.9'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'kimi-9.9.9.part'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'staged.json.swap-1234'))).resolves.toBeDefined();
    await expect(stat(join(stagingDir, claimExe))).resolves.toBeDefined();
    await expect(stat(join(stagingDir, youngExe))).resolves.toBeDefined();
  });

  it('retries short writes until each chunk is fully persisted', async () => {
    fsMocks.shortWriteBudget = 1;
    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
  });

  it('leaves foreign files in the staging directory alone', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(stagingDir, 'some-other-tool'), { recursive: true });
    await writeFile(join(stagingDir, 'user-notes.txt'), 'not ours', 'utf-8');
    await writeFile(join(stagingDir, 'some-other-tool', 'cache.bin'), 'not ours either');
    await agedOrphan(join(stagingDir, 'kimi-9.9.9'), Buffer.from('orphan-exe'));

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');

    await expect(stat(join(stagingDir, 'kimi-9.9.9'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'user-notes.txt'))).resolves.toBeDefined();
    await expect(stat(join(stagingDir, 'some-other-tool', 'cache.bin'))).resolves.toBeDefined();
  });

  it('cleans orphans with prerelease and build-metadata versions', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stagingDir, { recursive: true });
    await agedOrphan(join(stagingDir, 'kimi-1.2.3-rc.1'), Buffer.from('orphan'));
    await agedOrphan(join(stagingDir, 'kimi-1.2.3+build.5.exe'), Buffer.from('orphan'));
    await agedOrphan(join(stagingDir, 'kimi-1.2.3-rc.1.123.0.part'), Buffer.from('partial'));
    await agedOrphan(join(stagingDir, 'kimi-4.5.6.1234.1700000000000.0'), Buffer.from('orphan'));

    const result = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    expect(result.status).toBe('staged');

    await expect(stat(join(stagingDir, 'kimi-1.2.3-rc.1'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'kimi-1.2.3+build.5.exe'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'kimi-1.2.3-rc.1.123.0.part'))).rejects.toThrow();
    await expect(stat(join(stagingDir, 'kimi-4.5.6.1234.1700000000000.0'))).rejects.toThrow();
  });

  it("preserves another worker's staged result when this attempt fails", async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const exeFileName = `kimi-${VERSION}`;
    const otherPayload = Buffer.from('other-worker-payload');
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === nativeManifestUrl(VERSION)) {
        const manifestBody = JSON.stringify({
          version: VERSION,
          platforms: {
            'linux-x64': { filename: BINARY_FILENAME, checksum: sha256Hex(PAYLOAD) },
          },
        });
        return { ok: true, status: 200, text: async () => manifestBody, body: null };
      }
      if (url === nativeBinaryUrl(VERSION, BINARY_FILENAME)) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(stagingDir, { recursive: true });
        await writeFile(join(stagingDir, exeFileName), otherPayload);
        await writeFile(
          getNativeStagedStateFile(exePath),
          `${JSON.stringify({
            version: VERSION,
            target: 'linux-x64',
            exeFileName,
            sha256: sha256Hex(otherPayload),
            exeSize: otherPayload.length,
            stagedAt: new Date().toISOString(),
            channel: 'stable',
          })}\n`,
        );
        return { ok: false, status: 503, text: async () => '', body: null };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    await expect(
      stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl }),
    ).rejects.toThrow(/503/);

    const staged = await readStagedNativeUpdate(exePath);
    expect(staged?.version).toBe(VERSION);
    const bytes = await readFile(join(stagingDir, exeFileName));
    expect(bytes.equals(otherPayload)).toBe(true);
  });

  it('preserves the staged exe a live swap claim references when this attempt fails', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const exeFileName = `kimi-${VERSION}`;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === nativeManifestUrl(VERSION)) {
        const manifestBody = JSON.stringify({
          version: VERSION,
          platforms: {
            'linux-x64': { filename: BINARY_FILENAME, checksum: sha256Hex(PAYLOAD) },
          },
        });
        return { ok: true, status: 200, text: async () => manifestBody, body: null };
      }
      if (url === nativeBinaryUrl(VERSION, BINARY_FILENAME)) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(stagingDir, { recursive: true });
        await writeFile(join(stagingDir, exeFileName), PAYLOAD);
        await writeFile(
          join(stagingDir, 'staged.json.swap-4321'),
          JSON.stringify({ exeFileName }),
        );
        return { ok: false, status: 503, text: async () => '', body: null };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    await expect(
      stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl }),
    ).rejects.toThrow(/503/);

    const bytes = await readFile(join(stagingDir, exeFileName));
    expect(bytes.equals(PAYLOAD)).toBe(true);
  });
});

describe('promoteStagedUpdateToManual', () => {
  let workDir: string;
  let exePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-promote-test-'));
    exePath = join(workDir, 'bin', 'kimi');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('promotes the adopted record to manual', async () => {
    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    const adopted = await readStagedNativeUpdate(exePath);
    if (adopted === null) throw new Error('expected a staged record');

    await expect(promoteStagedUpdateToManual(exePath, adopted)).resolves.toBe(true);
    expect((await readStagedNativeUpdate(exePath))?.manual).toBe(true);
  });

  it('refuses to promote a record the staged metadata no longer matches', async () => {
    await stageNativeUpdate({
      version: '0.6.0',
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ version: '0.6.0', payload: Buffer.from('old-payload') }),
    });
    const adopted = await readStagedNativeUpdate(exePath);
    if (adopted === null) throw new Error('expected a staged record');

    await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });

    await expect(promoteStagedUpdateToManual(exePath, adopted)).resolves.toBe(false);
    const current = await readStagedNativeUpdate(exePath);
    expect(current?.version).toBe(VERSION);
    expect(current?.manual).toBeUndefined();
  });
});

describe('readStagedNativeUpdate', () => {
  let workDir: string;
  let exePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-staged-read-test-'));
    exePath = join(workDir, 'bin', 'kimi');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns null for malformed staged.json content', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(getNativeStagedStateFile(exePath), '{not json', 'utf-8');
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('returns null when exeFileName is not a plain file name', async () => {
    const { mkdir } = await import('node:fs/promises');
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      getNativeStagedStateFile(exePath),
      JSON.stringify({
        version: '0.7.0',
        target: 'linux-x64',
        exeFileName: '../../evil',
        sha256: 'a'.repeat(64),
        exeSize: 42,
        stagedAt: new Date().toISOString(),
      }),
      'utf-8',
    );
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });

  it('returns null when the exe size drifted from the metadata', async () => {
    const { staged } = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    await writeFile(stagedExePath(exePath, staged), Buffer.alloc(PAYLOAD.length + 1));
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
  });
});
