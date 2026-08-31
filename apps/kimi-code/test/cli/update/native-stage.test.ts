import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  /** Records chmod/rename calls (path-based) so tests can assert ordering. */
  calls: [] as Array<{ readonly op: 'chmod' | 'rename'; readonly path: string; readonly dst?: string }>,
  /** When > 0, the next open() wraps its handle so the first write is short. */
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
        // FileHandle methods live on the prototype, so delegate explicitly.
        write: async (
          buffer: Buffer,
          offset?: number | null,
          length?: number | null,
          position?: number | null,
        ) => {
          const off = offset ?? 0;
          const len = length ?? buffer.length - off;
          // The first write persists only half the requested bytes.
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
// The CDN serves the bare platform binary; the manifest checksum is its sha256.
const BINARY_FILENAME = 'kimi-code-linux-x64';

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Write a staging artifact old enough for the orphan sweep to reap it. */
async function agedOrphan(path: string, content: string | Buffer): Promise<void> {
  await writeFile(path, content);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(path, old, old);
}

interface MockCdnOptions {
  readonly version?: string;
  readonly payload: Buffer;
  readonly checksum?: string;
}

function mockCdnFetch(options: MockCdnOptions): typeof fetch {
  const version = options.version ?? VERSION;
  const manifestBody = JSON.stringify({
    version,
    tag: `v${version}`,
    platforms: {
      'linux-x64': {
        filename: BINARY_FILENAME,
        checksum: options.checksum ?? sha256Hex(options.payload),
      },
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
      target: 'linux-x64',
      sha256: sha256Hex(PAYLOAD),
      exeSize: PAYLOAD.length,
    });
    // The published exe name carries a unique per-worker infix: a staged
    // executable is never replaced once published, so the pathname a swap
    // validates at claim time is stable.
    expect(result.staged.exeFileName).toMatch(/^kimi-0\.7\.0\.\d+\.\d+\.\d+$/);

    const stagedOnDisk = await readStagedNativeUpdate(exePath);
    expect(stagedOnDisk).toEqual(result.staged);
    const exeBytes = await readFile(stagedExePath(exePath, result.staged));
    expect(exeBytes.equals(PAYLOAD)).toBe(true);
    // The .part intermediate is gone once the download was promoted.
    const leftovers = (await readdir(getNativeStagingDir(exePath))).filter((entry) =>
      entry.endsWith('.part'),
    );
    expect(leftovers).toEqual([]);
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
    // And it round-trips through the on-disk metadata.
    expect((await readStagedNativeUpdate(exePath))?.manual).toBe(true);
  });

  it('makes the download executable before publishing it at the staged name', async () => {
    // A concurrent swap may move the staged exe into place the instant it
    // appears at its published name, so the chmod must land on the private
    // .part file first — a later chmod could hit an already-moved path.
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
    // The chmod lands on the very .part file that gets published, before it.
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
    // One frame per chunk; the mock stream delivers the payload in one piece.
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
          // Stall forever — only the idle timeout's abort can end this.
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

    // Real timers with a 50 ms test override — fake timers interact badly
    // with async-generator suspension, so the idle timeout is injectable.
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
    // The failed attempt cleans up after itself.
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
    // The passive downloader staged the version first (no manual marker).
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
    // The promotion persisted to the on-disk metadata.
    expect((await readStagedNativeUpdate(exePath))?.manual).toBe(true);
  });

  it('re-stages when the staged exe is corrupted at the same size', async () => {
    const first = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: mockCdnFetch({ payload: PAYLOAD }),
    });
    // Same-size corruption after the download: the metadata still validates
    // (size matches), but the bytes no longer hash to the recorded checksum.
    await writeFile(stagedExePath(exePath, first.staged), Buffer.alloc(PAYLOAD.length));
    // Size-only readers still see the stage as valid…
    expect(await readStagedNativeUpdate(exePath)).not.toBeNull();

    const secondFetch = mockCdnFetch({ payload: PAYLOAD });
    const second = await stageNativeUpdate({
      version: VERSION,
      exePath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl: secondFetch,
    });

    // …but adoption re-verifies the digest, so the payload is re-downloaded
    // and published under a NEW generation name (a published exe is never
    // replaced — the damaged one is left for the orphan cleanup).
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
    // The metadata stays but the exe is deleted → not trustworthy, re-stage.
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

    // The superseding download fails verification. The old record must
    // survive: deleting it before the replacement is ready could remove a
    // concurrent worker's freshly published record, and here it would lose
    // a still-valid staged update.
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
    // Both the staged metadata and the .part download are gone.
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
    // Nothing was created anywhere.
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
    // The older stage's exe is left in place (it may be claim-held by a live
    // swap); an unreferenced one is reaped by a later orphan cleanup.
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
    // Age the staged exe past the orphan grace period: it is still the
    // applicable update (staged.json references it until the final atomic
    // write replaces the record), so the cleanup must not reap it.
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

    // Referenced at cleanup time → survives this run (a later cleanup reaps
    // it once the new record has replaced the old one).
    await expect(stat(oldExe)).resolves.toBeDefined();
  });

  it('cleans orphaned staging files before downloading, preserving live swap claims', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(stagingDir, { recursive: true });
    // Orphans from interrupted earlier runs: a referenced-by-nothing exe and
    // a stale .part download (aged past the orphan grace period).
    await agedOrphan(join(stagingDir, 'kimi-9.9.9'), Buffer.from('orphan-exe'));
    await agedOrphan(join(stagingDir, 'kimi-9.9.9.part'), Buffer.from('partial'));
    // A live swap claim referencing its own staged exe must survive.
    const claimExe = 'kimi-8.8.8';
    await writeFile(join(stagingDir, claimExe), Buffer.from('swap-in-progress'));
    await writeFile(
      join(stagingDir, 'staged.json.swap-1234'),
      JSON.stringify({ exeFileName: claimExe }),
    );
    // A fresh unreferenced exe is too young to be reaped: a concurrent
    // worker may be about to publish its metadata.
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
    // The first write to the .part file persists only half its bytes; the
    // write loop must make up the remainder or the staged exe is truncated.
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
    // A genuine updater-owned orphan to prove cleanup still works (aged past
    // the orphan grace period).
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
    // New-style published name with the unique per-worker infix.
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
        // A concurrent worker publishes its valid stage mid-download…
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
          })}\n`,
        );
        // …then this attempt's download fails.
        return { ok: false, status: 503, text: async () => '', body: null };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    await expect(
      stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl }),
    ).rejects.toThrow(/503/);

    // The concurrent worker's stage survives this attempt's failure cleanup.
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
        // A swap claims the stage mid-download: the metadata is renamed
        // aside (invisible to the metadata check), the exe still referenced
        // by the live claim.
        const { mkdir } = await import('node:fs/promises');
        await mkdir(stagingDir, { recursive: true });
        await writeFile(join(stagingDir, exeFileName), PAYLOAD);
        await writeFile(
          join(stagingDir, 'staged.json.swap-4321'),
          JSON.stringify({ exeFileName }),
        );
        // …then this attempt's download fails.
        return { ok: false, status: 503, text: async () => '', body: null };
      }
      return { ok: false, status: 404, text: async (): Promise<string> => '', body: null };
    }) as unknown as typeof fetch;

    await expect(
      stageNativeUpdate({ version: VERSION, exePath, platform: 'linux', arch: 'x64', fetchImpl }),
    ).rejects.toThrow(/503/);

    // The exe owned by the live swap survives this attempt's failure cleanup.
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

    // A newer stage is published before the explicit upgrade's promote
    // lands: the stale record must not overwrite it.
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
