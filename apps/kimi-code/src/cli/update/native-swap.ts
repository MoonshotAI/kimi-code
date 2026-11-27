import { spawn } from 'node:child_process';
import { readdir, readFile, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { log } from '@moonshot-ai/kimi-code-sdk';
import { takeProgramResumeToken } from '@moonshot-ai/pi-tui';

import {
  KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME,
  KIMI_CODE_UPDATE_REEXEC_ENV,
} from '#/constant/app';

import { readUpdateInstallState, writeUpdateInstallState } from './install-state';
import {
  hashFileSha256,
  parseStagedNativeUpdate,
  readStagedNativeUpdate,
  stagedExePath,
  type StagedNativeUpdate,
} from './native-stage';
import { isAutoUpdateDisabledByEnv, shouldAutoInstallUpdates } from './preflight';
import { decideUpdate } from './select';
import { getNativeStagedStateFile, getNativeStagingDir } from '#/utils/paths';
import { createFileIfAbsent } from '#/utils/persistence';

export interface NativeSwapDeps {
  readonly exePath: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly currentVersion: string;
  readonly isNative: boolean;
  readonly spawnImpl?: typeof spawn;
  readonly exitImpl?: (code: number) => void;
}

export interface SpawnedChild {
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
  );
}

const SWAP_CLAIM_STALE_MS = 5 * 60 * 1000;

const SWAP_MUTEX_STALE_MS = 60_000;

const STAGED_PUBLISH_GRACE_MS = 60_000;

const SMOKE_CHECK_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000;

function logSwap(message: string, payload: Record<string, unknown>): void {
  try {
    log.info(`native update swap: ${message}`, payload);
  } catch {}
}

async function recordSwapFailure(version: string): Promise<void> {
  try {
    const state = await readUpdateInstallState();
    const attempts =
      (state.lastFailure?.version === version ? state.lastFailure.attempts : 0) + 1;
    await writeUpdateInstallState({
      ...state,
      active: null,
      lastFailure: { version, failedAt: new Date().toISOString(), attempts },
    });
  } catch {}
}

function smokeCheck(
  exePath: string,
  staged: StagedNativeUpdate,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const smokeEnv: NodeJS.ProcessEnv = { ...env };
    takeProgramResumeToken(smokeEnv);
    let child: SpawnedChild & { readonly stdout?: NodeJS.ReadableStream | null; kill(): void };
    try {
      child = spawnImpl(exePath, ['--version'], {
        env: smokeEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }) as unknown as typeof child;
    } catch {
      finish(false);
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, SMOKE_CHECK_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      finish(code === 0 && stdout.trim() === staged.version);
    });
  });
}

interface ClaimedStaged {
  readonly staged: StagedNativeUpdate;
  readonly claimedPath: string;
}

async function claimStagedUpdate(exePath: string): Promise<ClaimedStaged | null> {
  const stateFile = getNativeStagedStateFile(exePath);
  const claimedPath = `${stateFile}.swap-${process.pid}`;
  const before = await stat(stateFile).catch(() => null);
  const youngAtClaim =
    before === null || Date.now() - before.mtimeMs <= STAGED_PUBLISH_GRACE_MS;
  try {
    await utimes(stateFile, new Date(), new Date()).catch(() => {});
    await rename(stateFile, claimedPath);
  } catch {
    return null;
  }
  const staged = await readStagedNativeUpdate(exePath, claimedPath);
  if (staged === null) {
    const raw = await readFile(claimedPath, 'utf-8').catch(() => null);
    const wellFormed = raw !== null && parseStagedNativeUpdate(raw) !== null;
    if (!wellFormed && youngAtClaim) {
      await rename(claimedPath, stateFile).catch(() => {});
      return null;
    }
    await unlink(claimedPath).catch(() => {});
    return null;
  }
  return { staged, claimedPath };
}

async function restoreClaimedUpdate(exePath: string, claimedPath: string): Promise<void> {
  const content = await readFile(claimedPath, 'utf-8').catch(() => null);
  if (content === null) {
    await unlink(claimedPath).catch(() => {});
    return;
  }
  try {
    await createFileIfAbsent(getNativeStagedStateFile(exePath), content);
  } catch (error) {
    if (!isAlreadyExists(error)) return;
  }
  await unlink(claimedPath).catch(() => {});
}

async function discardClaimedUpdate(claimedPath: string): Promise<void> {
  await unlink(claimedPath).catch(() => {});
}

async function rollback(bakPath: string, exePath: string): Promise<boolean> {
  try {
    await rename(bakPath, exePath);
    return true;
  } catch {
    return false;
  }
}

export interface SwapMutexHandle {
  release(): Promise<void>;
}

async function acquireSwapMutex(stagingDir: string): Promise<SwapMutexHandle | null> {
  const mutexPath = join(stagingDir, 'swap.lock');
  const marker = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await createFileIfAbsent(mutexPath, marker);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        return null;
      }
      if (attempt === 1) return null;
      const info = await stat(mutexPath).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs <= SWAP_MUTEX_STALE_MS) return null;
      await unlink(mutexPath).catch(() => {});
      continue;
    }
    const published = await readFile(mutexPath, 'utf-8').catch(() => null);
    if (published !== marker) return null;
    return {
      release: async (): Promise<void> => {
        const current = await readFile(mutexPath, 'utf-8').catch(() => null);
        if (current !== marker) return;
        await unlink(mutexPath).catch(() => {});
      },
    };
  }
  return null;
}

async function cleanupBackups(exePath: string, keepPath?: string): Promise<void> {
  const dir = dirname(exePath);
  const base = basename(exePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !entry.endsWith('.bak')) continue;
    const middle = entry.slice(base.length + 1, -'.bak'.length);
    if (middle !== '' && !/^\d+$/.test(middle)) continue;
    const full = join(dir, entry);
    if (full === keepPath) continue;
    await unlink(full).catch(() => {});
  }
}

async function cleanupStaleSwapClaims(exePath: string): Promise<boolean> {
  const stagingDir = getNativeStagingDir(exePath);
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch {
    return false;
  }
  let swapInProgress = false;
  for (const entry of entries) {
    if (!entry.startsWith(`${KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME}.swap-`)) continue;
    const full = join(stagingDir, entry);
    const info = await stat(full).catch(() => null);
    if (info === null) continue;
    if (Date.now() - info.mtimeMs < SWAP_CLAIM_STALE_MS) {
      swapInProgress = true;
      continue;
    }
    await restoreClaimedUpdate(exePath, full);
  }
  return swapInProgress;
}

async function sweepStaleNativeUpdateArtifacts(exePath: string): Promise<boolean> {
  try {
    if (await cleanupStaleSwapClaims(exePath)) {
      return true;
    }
    const mutexInfo = await stat(join(getNativeStagingDir(exePath), 'swap.lock')).catch(
      () => null,
    );
    if (mutexInfo !== null && Date.now() - mutexInfo.mtimeMs <= SWAP_MUTEX_STALE_MS) {
      return true;
    }
    await cleanupBackups(exePath);
  } catch {}
  return false;
}

function reexec(
  deps: NativeSwapDeps & { readonly spawnImpl: typeof spawn },
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = deps.spawnImpl(deps.exePath, deps.argv.slice(2), {
        stdio: 'inherit',
        env: { ...deps.env, [KIMI_CODE_UPDATE_REEXEC_ENV]: '1' },
      }) as unknown as SpawnedChild;
    } catch (error) {
      logSwap('re-exec spawn threw', { error: String(error) });
      resolve(false);
      return;
    }
    child.once('error', (error) => {
      logSwap('re-exec spawn failed', { error: error.message });
      resolve(false);
    });
    child.once('exit', (code, signal) => {
      resolve(true);
      const exitImpl = deps.exitImpl ?? ((exitCode: number) => process.exit(exitCode));
      if (code !== null) {
        exitImpl(code);
        return;
      }
      const signo = signal !== null ? (osConstants.signals[signal] ?? 0) : 0;
      exitImpl(signo > 0 ? 128 + signo : 1);
    });
  });
}

export async function maybeRelaunchWithStagedNativeUpdate(
  deps: NativeSwapDeps,
): Promise<boolean> {
  if (!deps.isNative) return false;
  const swapInProgress = await sweepStaleNativeUpdateArtifacts(deps.exePath);
  if (isTruthy(deps.env[KIMI_CODE_UPDATE_REEXEC_ENV])) {
    delete deps.env[KIMI_CODE_UPDATE_REEXEC_ENV];
    return false;
  }
  if (swapInProgress) {
    logSwap('another instance is mid-swap, skipping', { exePath: deps.exePath });
    return false;
  }

  const claimed = await claimStagedUpdate(deps.exePath);
  if (claimed === null) return false;
  const { staged, claimedPath } = claimed;
  const spawnImpl = deps.spawnImpl ?? spawn;

  const discard = async (): Promise<boolean> => {
    await discardClaimedUpdate(claimedPath);
    return false;
  };

  const plan = decideUpdate(deps.currentVersion, {
    channel: staged.channel,
    latest: staged.version,
  });
  const allowed = plan.kind === 'upgrade' || (
    plan.kind === 'switch-channel' &&
    staged.manual === true &&
    staged.intent === 'switch-channel'
  );
  if (!allowed) {
    logSwap('discarding staged update (not an allowed update)', {
      staged: staged.version,
      current: deps.currentVersion,
    });
    return discard();
  }

  if (
    staged.manual !== true &&
    (isAutoUpdateDisabledByEnv(deps.env) || !(await shouldAutoInstallUpdates()))
  ) {
    await restoreClaimedUpdate(deps.exePath, claimedPath);
    return false;
  }

  const digest = await hashFileSha256(stagedExePath(deps.exePath, staged));
  if (digest !== staged.sha256) {
    logSwap('staged exe failed checksum verification, discarding', {
      version: staged.version,
    });
    return discard();
  }

  const stagedExe = stagedExePath(deps.exePath, staged);

  if (!(await smokeCheck(stagedExe, staged, deps.env, spawnImpl))) {
    logSwap('smoke check failed, discarding staged update', { version: staged.version });
    await recordSwapFailure(staged.version);
    return discard();
  }

  const swapMutex = await acquireSwapMutex(getNativeStagingDir(deps.exePath));
  if (swapMutex === null) {
    logSwap('another instance is in its swap critical section, deferring', {
      exePath: deps.exePath,
    });
    await restoreClaimedUpdate(deps.exePath, claimedPath);
    return false;
  }
  try {
    let bakPath = `${deps.exePath}.bak`;
    try {
      await unlink(bakPath);
    } catch (error) {
      if (!isNotFound(error)) {
        bakPath = `${deps.exePath}.${process.pid}.bak`;
      }
    }
    try {
      await rename(deps.exePath, bakPath);
    } catch (error) {
      logSwap('failed to move exe aside', { exePath: deps.exePath, error: String(error) });
      await restoreClaimedUpdate(deps.exePath, claimedPath);
      return false;
    }

    if ((await rename(stagedExe, deps.exePath).catch(() => null)) === null) {
      logSwap('failed to move staged exe into place, rolling back', { exePath: deps.exePath });
      if (!(await rollback(bakPath, deps.exePath))) {
        logSwap('rollback failed, keeping recovery artifacts', {
          exePath: deps.exePath,
          bakPath,
        });
        await recordSwapFailure(staged.version);
        return false;
      }
      await recordSwapFailure(staged.version);
      return await discard();
    }

    await unlink(claimedPath).catch(() => {});
    await unlink(bakPath).catch(() => {});
    await cleanupBackups(deps.exePath, bakPath);
    logSwap('swap succeeded, re-launching', { version: staged.version });
  } finally {
    await swapMutex.release();
  }
  await rmdir(getNativeStagingDir(deps.exePath)).catch(() => {});
  return reexec({ ...deps, spawnImpl });
}
