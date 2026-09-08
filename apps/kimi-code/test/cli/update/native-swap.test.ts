import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdateInstallState } from '#/cli/update/install-state';
import { readStagedNativeUpdate, stagedExeFileName } from '#/cli/update/native-stage';
import {
  maybeRelaunchWithStagedNativeUpdate,
  type NativeSwapDeps,
} from '#/cli/update/native-swap';
import { KIMI_CODE_UPDATE_REEXEC_ENV } from '#/constant/app';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';

const fsMocks = vi.hoisted(() => ({
  /** When set, renames matching the predicate fail with an injected error. */
  renameBlocker: null as null | ((src: string, dst: string) => boolean),
  /** When set, link() throws an error with this code (no hard-link support). */
  linkError: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (
      src: Parameters<typeof actual.rename>[0],
      dst: Parameters<typeof actual.rename>[1],
    ) => {
      if (fsMocks.renameBlocker?.(String(src), String(dst)) === true) {
        throw new Error('injected rename failure');
      }
      return actual.rename(src, dst);
    },
    link: async (
      src: Parameters<typeof actual.link>[0],
      dst: Parameters<typeof actual.link>[1],
    ) => {
      if (fsMocks.linkError !== null) {
        throw Object.assign(new Error('link() is not supported (mocked)'), {
          code: fsMocks.linkError,
        });
      }
      return actual.link(src, dst);
    },
  };
});

const CURRENT_VERSION = '0.6.0';
const STAGED_VERSION = '0.7.0';
const STAGED_EXE_SIZE = 42;

interface FakeChildHandlers {
  readonly onEvent: (event: 'error' | 'exit' | 'close', cb: (...args: unknown[]) => void) => void;
  readonly child: unknown;
}

function fakeChild(options: {
  readonly code?: number | null;
  readonly stdout?: string;
  readonly error?: Error;
  readonly signal?: NodeJS.Signals | null;
}): FakeChildHandlers {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const stdoutChunks: string[] = [];
  const stdoutListeners: Array<(chunk: Buffer) => void> = [];
  const child = {
    once(event: string, cb: (...args: unknown[]) => void) {
      listeners.set(event, cb);
    },
    stdout: {
      on(_event: 'data', cb: (chunk: Buffer) => void) {
        stdoutListeners.push(cb);
      },
    },
    kill: vi.fn(),
  };
  queueMicrotask(() => {
    if (options.error !== undefined) {
      listeners.get('error')?.(options.error);
      return;
    }
    if (options.stdout !== undefined) {
      for (const cb of stdoutListeners) cb(Buffer.from(options.stdout));
    }
    const code = options.code === undefined ? 0 : options.code;
    const signal = options.signal ?? null;
    // The smoke check listens on 'close', the re-exec waiter on 'exit'.
    listeners.get('close')?.(code, signal);
    listeners.get('exit')?.(code, signal);
  });
  void stdoutChunks;
  return { onEvent: () => {}, child };
}

interface SpawnCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

function createSpawnMock(routes: {
  readonly smokeCode?: number;
  readonly smokeStdout?: string;
  readonly reexecCode?: number;
  readonly reexecError?: Error;
  readonly reexecSignal?: NodeJS.Signals;
}): { readonly calls: SpawnCall[]; readonly spawnImpl: NativeSwapDeps['spawnImpl'] } {
  const calls: SpawnCall[] = [];
  const spawnImpl = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    if (args[0] === '--version') {
      return fakeChild({
        code: routes.smokeCode ?? 0,
        stdout: routes.smokeStdout ?? `${STAGED_VERSION}\n`,
      }).child;
    }
    return fakeChild({
      code: routes.reexecSignal !== undefined ? null : (routes.reexecCode ?? 0),
      error: routes.reexecError,
      signal: routes.reexecSignal ?? null,
    }).child;
  }) as unknown as NativeSwapDeps['spawnImpl'];
  return { calls, spawnImpl };
}

async function seedStagedUpdate(
  exePath: string,
  version: string,
  options?: { readonly manual?: boolean },
): Promise<void> {
  const stagingDir = getNativeStagingDir(exePath);
  await mkdir(stagingDir, { recursive: true });
  const exeBytes = Buffer.alloc(STAGED_EXE_SIZE, 1);
  await writeFile(join(stagingDir, stagedExeFileName(version, 'linux')), exeBytes);
  await writeFile(
    getNativeStagedStateFile(exePath),
    `${JSON.stringify({
      version,
      target: 'linux-x64',
      exeFileName: stagedExeFileName(version, 'linux'),
      // The swap re-verifies the staged bytes against this checksum, so the
      // seed must record the payload's real sha256.
      sha256: createHash('sha256').update(exeBytes).digest('hex'),
      exeSize: STAGED_EXE_SIZE,
      stagedAt: new Date().toISOString(),
      manual: options?.manual === true ? true : undefined,
    }, null, 2)}\n`,
    'utf-8',
  );
}

function makeDeps(
  exePath: string,
  overrides: Partial<NativeSwapDeps> & { readonly spawnImpl: NativeSwapDeps['spawnImpl'] },
): NativeSwapDeps {
  return {
    exePath,
    argv: ['node', exePath, '--flag', 'value'],
    env: { PATH: '/usr/bin' },
    currentVersion: CURRENT_VERSION,
    isNative: true,
    exitImpl: vi.fn(),
    ...overrides,
  };
}

describe('maybeRelaunchWithStagedNativeUpdate', () => {
  let workDir: string;
  let exePath: string;
  let homeDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'kimi-swap-test-'));
    homeDir = join(workDir, 'home');
    exePath = join(workDir, 'bin', 'kimi');
    await mkdir(join(workDir, 'bin'), { recursive: true });
    await writeFile(exePath, 'old-binary');
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    fsMocks.renameBlocker = null;
    fsMocks.linkError = null;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(workDir, { recursive: true, force: true });
  });

  it('does nothing when the re-exec guard env is set', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const env = { [KIMI_CODE_UPDATE_REEXEC_ENV]: '1' };
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, env }),
    );
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // Read-once: the guard is dropped so children of this session do not inherit it.
    expect(env[KIMI_CODE_UPDATE_REEXEC_ENV]).toBeUndefined();
    // Staged files untouched for the "real" next launch.
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('does nothing when not running as a native binary', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, isNative: false }),
    );
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('does nothing when nothing is staged', async () => {
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('discards a staged update that is not newer than the running version', async () => {
    await seedStagedUpdate(exePath, CURRENT_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    // The metadata is gone, so future launches do not retry the discard; the
    // exe is left for the downloader's orphan cleanup (it may belong to a
    // freshly republished stage).
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(
      stat(join(getNativeStagingDir(exePath), stagedExeFileName(CURRENT_VERSION, 'linux'))),
    ).resolves.toBeDefined();
  });

  it('discards staged metadata whose exe is missing', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    await rm(join(getNativeStagingDir(exePath), stagedExeFileName(STAGED_VERSION, 'linux')));
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('swaps in the staged exe, re-execs with the original argv and forwards the exit code', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({ reexecCode: 3 });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );

    expect(relaunched).toBe(true);
    // Smoke check + re-exec.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[1]?.cmd).toBe(exePath);
    expect(calls[1]?.args).toEqual(['--flag', 'value']);
    expect((calls[1]?.options['env'] as Record<string, string>)[KIMI_CODE_UPDATE_REEXEC_ENV]).toBe('1');
    expect(calls[1]?.options['stdio']).toBe('inherit');
    expect(exitImpl).toHaveBeenCalledWith(3);

    // The exe was replaced with the staged payload; backup and staging are gone.
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
    await expect(stat(`${exePath}.bak`)).rejects.toThrow();
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(getNativeStagingDir(exePath))).rejects.toThrow();
  });

  it('rolls back when the smoke check fails and records an install failure', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({ smokeCode: 1 });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );

    expect(relaunched).toBe(false);
    expect(exitImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // smoke only, no re-exec
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    // The exe is left for the downloader's orphan cleanup (see the
    // not-newer discard test).

    const state = await readUpdateInstallState();
    expect(state.lastFailure).toMatchObject({ version: STAGED_VERSION, attempts: 1 });
  });

  it('rolls back when the smoke output does not contain the staged version', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ smokeStdout: '0.0.0-bogus\n' });
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('rolls back when the smoke output merely contains the staged version as a substring', async () => {
    // `0.7.01` contains `0.7.0` but is a different release — a mispublished
    // endpoint could serve exactly that with a matching checksum.
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ smokeStdout: `${STAGED_VERSION}1\n` });
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));
    expect(relaunched).toBe(false);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('continues startup with the old in-memory code when the re-exec spawn fails', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ reexecError: new Error('spawn EACCES') });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );
    expect(relaunched).toBe(false);
    expect(exitImpl).not.toHaveBeenCalled();
    // The binary on disk is already the new version; the next launch picks it up.
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('forwards a signal-derived nonzero exit code when the re-exec child is killed', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { spawnImpl } = createSpawnMock({ reexecSignal: 'SIGKILL' });
    const exitImpl = vi.fn();
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl, exitImpl }),
    );
    expect(relaunched).toBe(true);
    // 128 + 9 (SIGKILL), never a success-looking 0.
    expect(exitImpl).toHaveBeenCalledWith(137);
  });

  it('restores the staged metadata when the exe cannot be moved aside', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // rename(exe → bak) fails when the in-service exe is gone.
    await rm(exePath);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    // The smoke check runs before anything is moved; only the re-exec is absent.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['--version']);
    // The staged update is restored, not dropped: a later launch retries the swap.
    const restored = await readStagedNativeUpdate(exePath);
    expect(restored).toMatchObject({ version: STAGED_VERSION });
    await expect(
      stat(join(getNativeStagingDir(exePath), stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();
  });

  it('restores the staged metadata without hard-link support', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // The restore publishes create-if-absent; on filesystems without hard
    // links it must fall back to an exclusive create, not drop the stage.
    fsMocks.linkError = 'ENOTSUP';
    // rename(exe → bak) fails when the in-service exe is gone.
    await rm(exePath);
    const { spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    const restored = await readStagedNativeUpdate(exePath);
    expect(restored).toMatchObject({ version: STAGED_VERSION });
  });

  it('retains the claim when the restore hits a transient error', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // rename(exe → bak) fails when the in-service exe is gone.
    await rm(exePath);
    // ENOSPC is not a hard-link-support error: the restore's create-if-absent
    // publish fails transiently, and the claim must be RETAINED for a later
    // launch's sweep — dropping it would orphan the staged exe with no newer
    // stage to show for it.
    fsMocks.linkError = 'ENOSPC';
    const { spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    // The state file was not published, and the claim is still there.
    expect(await readStagedNativeUpdate(exePath)).toBeNull();
    const names = await readdir(getNativeStagingDir(exePath));
    expect(names.some((name) => name.startsWith('staged.json.swap-'))).toBe(true);
  });

  it('restores an aged orphaned claim and swaps it on that very launch', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // Simulate a claim left by a dead swap: the record renamed aside and aged
    // past the claim-stale threshold.
    const claimPath = join(getNativeStagingDir(exePath), 'staged.json.swap-99999');
    await rename(getNativeStagedStateFile(exePath), claimPath);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(claimPath, old, old);

    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    // The sweep restored the claim, and this launch swapped the update in.
    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2);
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('defers the swap while another instance holds the swap mutex', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // A fresh swap.lock = another instance in its rename critical section.
    await writeFile(join(getNativeStagingDir(exePath), 'swap.lock'), 'other-instance');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // The stage is untouched for a later launch; the exe is untouched.
    expect(await readStagedNativeUpdate(exePath)).toMatchObject({ version: STAGED_VERSION });
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('sweeps an aged swap mutex and proceeds with the swap', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const mutexPath = join(getNativeStagingDir(exePath), 'swap.lock');
    await writeFile(mutexPath, 'crash-residue');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(mutexPath, old, old);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2);
    // The mutex was released after the swap.
    await expect(stat(mutexPath)).rejects.toThrow();
  });

  it('puts a young unparseable staged record back instead of destroying it', async () => {
    // An in-flight exclusive-create publish (filesystems without hard links)
    // is observable mid-write; claiming and discarding it would orphan the
    // staged exe while the writer still reports success.
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const stateFile = getNativeStagedStateFile(exePath);
    await writeFile(stateFile, '{', 'utf-8');
    const { spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(await readFile(stateFile, 'utf-8')).toBe('{');
  });

  it('discards an aged unparseable staged record as crash residue', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const stateFile = getNativeStagedStateFile(exePath);
    await writeFile(stateFile, '{', 'utf-8');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(stateFile, old, old);
    const { spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    await expect(stat(stateFile)).rejects.toThrow();
  });

  it('falls back to a pid-named backup when the plain .bak cannot be removed', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // A directory at `${exePath}.bak` cannot be removed via unlink → pid fallback.
    await mkdir(`${exePath}.bak`);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2);
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
    // The pid-named backup was cleaned after the swap; the directory is untouched.
    const names = await readdir(join(workDir, 'bin'));
    expect(names.toSorted()).toEqual(['kimi', 'kimi.bak']);
    expect((await stat(`${exePath}.bak`)).isDirectory()).toBe(true);
  });

  it('sweeps stale backups from earlier swaps on startup', async () => {
    await writeFile(`${exePath}.bak`, 'stale-backup');
    await writeFile(`${exePath}.12345.bak`, 'stale-backup');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
    await expect(stat(`${exePath}.bak`)).rejects.toThrow();
    await expect(stat(`${exePath}.12345.bak`)).rejects.toThrow();
  });

  it('leaves foreign .bak files alone during backup cleanup', async () => {
    await writeFile(`${exePath}.bak`, 'stale-backup');
    await writeFile(`${exePath}.config.bak`, 'user-backup');
    await writeFile(`${exePath}.notes.bak`, 'user-backup');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // Only the updater-owned exact backup is swept.
    await expect(stat(`${exePath}.bak`)).rejects.toThrow();
    expect(await readFile(`${exePath}.config.bak`, 'utf-8')).toBe('user-backup');
    expect(await readFile(`${exePath}.notes.bak`, 'utf-8')).toBe('user-backup');
  });

  it('leaves every artifact alone while another instance holds a fresh swap claim', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(claimPath, '{}\n', 'utf-8');
    await writeFile(`${exePath}.bak`, 'in-use-backup');
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // A mid-swap instance owns these: nothing is touched.
    await expect(stat(claimPath)).resolves.toBeDefined();
    await expect(stat(`${exePath}.bak`)).resolves.toBeDefined();
  });

  it('does not claim a newly staged update while another instance is mid-swap', async () => {
    // Instance A holds a fresh claim; a downloader has since published a new
    // staged.json. Claiming it here would start a second concurrent swap.
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(claimPath, '{}\n', 'utf-8');
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // The staged update and the claim stay put; the launch after the
    // in-flight swap ends picks the update up.
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    await expect(stat(claimPath)).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('cleans up stale swap claims without touching staged exes', async () => {
    const stagingDir = getNativeStagingDir(exePath);
    await mkdir(stagingDir, { recursive: true });
    const exeFileName = stagedExeFileName(STAGED_VERSION, 'linux');
    const orphanedExe = join(stagingDir, exeFileName);
    await writeFile(orphanedExe, Buffer.alloc(STAGED_EXE_SIZE, 1));
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(
      claimPath,
      `${JSON.stringify({
        version: STAGED_VERSION,
        target: 'linux-x64',
        exeFileName,
        sha256: 'a'.repeat(64),
        exeSize: STAGED_EXE_SIZE,
        stagedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      }, null, 2)}\n`,
      'utf-8',
    );
    // Crash residue: the claim is older than the stale window.
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(claimPath, past, past);

    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(stat(claimPath)).rejects.toThrow();
    // The exe the claim referenced is left in place: it may belong to a
    // freshly republished stage, and the downloader's orphan cleanup reaps
    // it if nothing references it.
    await expect(stat(orphanedExe)).resolves.toBeDefined();
  });

  it('keeps recovery artifacts when both the swap-in rename and the rollback fail', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // Every rename INTO the install path fails: the staged exe cannot move
    // in, and the backup cannot move back (transient lock, AV, …).
    fsMocks.renameBlocker = (_src, dst) => dst === exePath;
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(1); // smoke check only, no re-exec
    // The install path stays absent, but both recovery copies survive: the
    // `.bak` IS the old exe, and the staged payload plus its claim are not
    // discarded.
    await expect(stat(exePath)).rejects.toThrow();
    expect(await readFile(`${exePath}.bak`, 'utf-8')).toBe('old-binary');
    const stagingDir = getNativeStagingDir(exePath);
    await expect(
      stat(join(stagingDir, stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();
    await expect(
      stat(join(stagingDir, `staged.json.swap-${process.pid}`)),
    ).resolves.toBeDefined();
  });

  it('keeps the exe a fresh staged.json references when sweeping a stale claim', async () => {
    // A swap crashed after claiming V (stale claim residue), and a downloader
    // has since re-staged V: both records reference the same version-derived
    // exe name. Sweeping the claim must not delete the freshly staged exe.
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const stagingDir = getNativeStagingDir(exePath);
    const claimPath = join(stagingDir, 'staged.json.swap-4242');
    await writeFile(
      claimPath,
      `${JSON.stringify({
        version: STAGED_VERSION,
        target: 'linux-x64',
        exeFileName: stagedExeFileName(STAGED_VERSION, 'linux'),
        sha256: 'a'.repeat(64),
        exeSize: STAGED_EXE_SIZE,
        stagedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      })}\n`,
      'utf-8',
    );
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(claimPath, past, past);

    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    // The stale claim is swept, the fresh stage survives and is swapped in.
    await expect(stat(claimPath)).rejects.toThrow();
    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2); // smoke check + re-exec
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('discards a staged update whose exe fails the recorded checksum', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // Same size, different bytes — post-download on-disk damage.
    const stagingDir = getNativeStagingDir(exePath);
    const stagedExe = join(stagingDir, stagedExeFileName(STAGED_VERSION, 'linux'));
    await writeFile(stagedExe, Buffer.alloc(STAGED_EXE_SIZE, 2));
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // The corrupt stage's metadata is discarded so a later cycle re-stages
    // it; the exe is left for the downloader's orphan cleanup, and the
    // running exe is never touched.
    await expect(stat(getNativeStagedStateFile(exePath))).rejects.toThrow();
    await expect(stat(stagedExe)).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('leaves a staged update in place when automatic updates are disabled by env', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, {
        spawnImpl,
        env: { PATH: '/usr/bin', KIMI_CODE_NO_AUTO_UPDATE: '1' },
      }),
    );

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    // The payload stays staged for a later launch without the opt-out; the
    // running exe is untouched.
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('applies a manually staged update even when automatic updates are disabled by env', async () => {
    // The opt-out targets automatic updates; an explicit `kimi upgrade`
    // stages with manual: true and must still apply.
    await seedStagedUpdate(exePath, STAGED_VERSION, { manual: true });
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, {
        spawnImpl,
        env: { PATH: '/usr/bin', KIMI_CODE_NO_AUTO_UPDATE: '1' },
      }),
    );

    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2); // smoke check + re-exec
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('leaves an automatic stage in place when auto_install is disabled in the tui config', async () => {
    await mkdir(homeDir, { recursive: true });
    await writeFile(join(homeDir, 'tui.toml'), '[upgrade]\nauto_install = false\n', 'utf-8');
    await seedStagedUpdate(exePath, STAGED_VERSION);
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    expect(calls).toHaveLength(0);
    await expect(stat(getNativeStagedStateFile(exePath))).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('applies a manual stage even when auto_install is disabled in the tui config', async () => {
    await mkdir(homeDir, { recursive: true });
    await writeFile(join(homeDir, 'tui.toml'), '[upgrade]\nauto_install = false\n', 'utf-8');
    await seedStagedUpdate(exePath, STAGED_VERSION, { manual: true });
    const { calls, spawnImpl } = createSpawnMock({});
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(true);
    expect(calls).toHaveLength(2); // smoke check + re-exec
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });

  it('does not overwrite a concurrently published stage when restoring the claim', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // The exe move (step 2) fails.
    fsMocks.renameBlocker = (src) => src === exePath;
    const v2 = '0.8.0';
    const spawnImpl = ((cmd: string, args: readonly string[]) => {
      if (args[0] === '--version') {
        // Mid-smoke: a downloader publishes a NEWER stage (the state-file
        // path is free — we claimed the older one).
        const stagingDir = getNativeStagingDir(exePath);
        const v2Exe = stagedExeFileName(v2, 'linux');
        writeFileSync(join(stagingDir, v2Exe), 'newer-binary');
        writeFileSync(
          getNativeStagedStateFile(exePath),
          `${JSON.stringify({
            version: v2,
            target: 'linux-x64',
            exeFileName: v2Exe,
            sha256: 'b'.repeat(64),
            exeSize: Buffer.byteLength('newer-binary'),
            stagedAt: new Date().toISOString(),
          })}\n`,
        );
        return fakeChild({ code: 0, stdout: `${STAGED_VERSION}\n` }).child;
      }
      return fakeChild({ code: 0 }).child;
    }) as unknown as NativeSwapDeps['spawnImpl'];
    const relaunched = await maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl }));

    expect(relaunched).toBe(false);
    // The newer stage survived; the older claim's metadata was discarded
    // instead of clobbering it (its exe is left for the downloader's orphan
    // cleanup), and the running exe never moved.
    const staged = await readStagedNativeUpdate(exePath);
    expect(staged?.version).toBe(v2);
    await expect(
      stat(join(getNativeStagingDir(exePath), stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();
    expect(await readFile(exePath, 'utf-8')).toBe('old-binary');
  });

  it('stamps the claim with a fresh mtime so a concurrent launch does not misread it as stale', async () => {
    await seedStagedUpdate(exePath, STAGED_VERSION);
    // The metadata may have been staged long before this launch (background
    // download finished hours ago); rename alone would keep that old mtime.
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(getNativeStagedStateFile(exePath), longAgo, longAgo);

    // Instance A: park inside the smoke check, holding the claim mid-swap.
    let releaseSmoke!: () => void;
    const smokeGate = new Promise<void>((resolve) => {
      releaseSmoke = resolve;
    });
    const spawnImplA = ((cmd: string, args: readonly string[]) => {
      if (args[0] !== '--version') return fakeChild({ code: 0 }).child; // re-exec
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const stdoutListeners: Array<(chunk: Buffer) => void> = [];
      const child = {
        once(event: string, cb: (...args: unknown[]) => void) {
          listeners.set(event, cb);
        },
        stdout: {
          on(_event: 'data', cb: (chunk: Buffer) => void) {
            stdoutListeners.push(cb);
          },
        },
        kill: vi.fn(),
      };
      const emitSmokeSuccess = (): void => {
        for (const cb of stdoutListeners) cb(Buffer.from(`${STAGED_VERSION}\n`));
        listeners.get('close')?.(0, null);
        listeners.get('exit')?.(0, null);
      };
      queueMicrotask(() => {
        void smokeGate.then(emitSmokeSuccess);
      });
      return child;
    }) as unknown as NativeSwapDeps['spawnImpl'];
    const promiseA = maybeRelaunchWithStagedNativeUpdate(makeDeps(exePath, { spawnImpl: spawnImplA }));

    // Wait until A holds the claim.
    const stagingDir = getNativeStagingDir(exePath);
    const claimPath = join(stagingDir, `staged.json.swap-${process.pid}`);
    await vi.waitFor(() => {
      expect(existsSync(claimPath)).toBe(true);
    });
    // The claim carries the claim time, not the staged file's old mtime.
    expect((await stat(claimPath)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);

    // Instance B: its sweep must treat A's claim as live and touch nothing.
    const { calls: callsB, spawnImpl: spawnImplB } = createSpawnMock({});
    const relaunchedB = await maybeRelaunchWithStagedNativeUpdate(
      makeDeps(exePath, { spawnImpl: spawnImplB }),
    );
    expect(relaunchedB).toBe(false);
    expect(callsB).toHaveLength(0);
    await expect(stat(claimPath)).resolves.toBeDefined();
    await expect(
      stat(join(stagingDir, stagedExeFileName(STAGED_VERSION, 'linux'))),
    ).resolves.toBeDefined();

    // A finishes the swap unharmed.
    releaseSmoke();
    await expect(promiseA).resolves.toBe(true);
    const newExe = await readFile(exePath);
    expect(newExe.equals(Buffer.alloc(STAGED_EXE_SIZE, 1))).toBe(true);
  });
});
