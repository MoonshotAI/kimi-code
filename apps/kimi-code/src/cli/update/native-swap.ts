/**
 * Native staged swap, executed at the very top of startup.
 *
 * When a staged update is ready (`.staging/staged.json` next to the running
 * exe), swap it in atomically and re-exec so the user session runs the new
 * binary immediately. Everything here is best-effort: any failure leaves the
 * current exe intact (rollback from `.bak`) and startup continues normally.
 *
 * Windows semantics make this safe: a running exe can be renamed but not
 * overwritten, so the sequence is `rename exe→.bak` (the running process is
 * unaffected), `rename staged→exe`, then delete `.bak` (best effort — a
 * concurrent old instance keeps it locked until it exits). This is the same
 * mechanism install.ps1 already relies on, and the Squirrel/NSIS-style
 * "next launch performs the swap" pattern. Leftovers a swap cannot remove
 * (its own `.bak` while still running, crash residue in `.staging/`) are
 * swept best-effort on every launch.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { gt } from 'semver';

import { log } from '@moonshot-ai/kimi-code-sdk';

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

/**
 * A `staged.json.swap-<pid>` claim file younger than this marks a swap in
 * progress in another instance; older ones are crash residue. The bound
 * comfortably exceeds the slowest swap (smoke-check timeout included).
 */
const SWAP_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * The swap's executable-renaming critical section is a few filesystem ops
 * (well under a second), so a swap mutex older than this is crash residue.
 */
const SWAP_MUTEX_STALE_MS = 60_000;

/**
 * A young unparseable `staged.json` may be an in-flight exclusive-create
 * publish (observable mid-write on filesystems without hard links — see
 * createFileIfAbsent), not corruption. The publish gap is microscopic, so
 * only records younger than this get the benefit of the doubt.
 */
const STAGED_PUBLISH_GRACE_MS = 60_000;

// First launch of a fresh ~150 MB unsigned exe can sit in an antivirus scan;
// give Windows extra headroom so a slow scan is not misread as a broken binary.
const SMOKE_CHECK_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000;

function logSwap(message: string, payload: Record<string, unknown>): void {
  try {
    log.info(`native update swap: ${message}`, payload);
  } catch {
    // Diagnostics must never affect startup.
  }
}

/** Record a swap failure so preflight stops re-staging the same bad version. */
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
  } catch {
    // Never block startup on bookkeeping.
  }
}

/**
 * Run `exe --version` as a smoke check: exit code 0 and the EXACT staged
 * version as the output (commander prints `<version>\n`). A substring check
 * would let a mispublished binary satisfy the wrong target (`1.2.30`
 * contains `1.2.3`) — and the manifest checksum cannot catch that case when
 * it also describes the wrong artifact.
 */
function smokeCheck(
  exePath: string,
  staged: StagedNativeUpdate,
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
    let child: SpawnedChild & { readonly stdout?: NodeJS.ReadableStream | null; kill(): void };
    try {
      child = spawnImpl(exePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }) as unknown as typeof child;
    } catch {
      finish(false);
      return;
    }
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(false);
    }, SMOKE_CHECK_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.once('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
    // 'close', not 'exit': stdio may still be flushing when 'exit' fires, and
    // the check needs the complete version output.
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

/**
 * Atomically claim the staged metadata file (rename is atomic on both NTFS
 * and POSIX, so exactly one of several concurrently starting instances wins),
 * THEN parse the claimed contents. Claim-first matters: a concurrent
 * downloader may supersede `staged.json` at any moment, so validating before
 * the rename could act on metadata this swap never claimed.
 *
 * Returns null when there is nothing staged, the file disappeared under us,
 * or the claimed metadata failed consistency checks. A claimed record that is
 * UNPARSEABLE but was young at claim time may be an in-flight
 * exclusive-create publish (observable mid-write where hard links are
 * unsupported): it is put back with the same inode so the writer completes
 * it, never destroyed. Aged corrupt residue and well-formed records whose exe
 * is gone/changed are deterministically dead and discarded.
 */
async function claimStagedUpdate(exePath: string): Promise<ClaimedStaged | null> {
  const stateFile = getNativeStagedStateFile(exePath);
  const claimedPath = `${stateFile}.swap-${process.pid}`;
  // Capture the record's age BEFORE the stamp below rewrites it.
  const before = await stat(stateFile).catch(() => null);
  const youngAtClaim =
    before === null || Date.now() - before.mtimeMs <= STAGED_PUBLISH_GRACE_MS;
  try {
    // The metadata's mtime can be arbitrarily old — the download may have
    // finished hours before this launch. Stamp it BEFORE the rename so the
    // claim is born fresh: a concurrent launch's sweep never observes a live
    // claim that looks like crash residue (and would delete the staged exe
    // plus this swap's rollback backup). Stamping the state file itself is
    // harmless — nothing reads its mtime.
    await utimes(stateFile, new Date(), new Date()).catch(() => {});
    await rename(stateFile, claimedPath);
  } catch {
    return null;
  }
  // Parse exactly the metadata we claimed.
  const staged = await readStagedNativeUpdate(exePath, claimedPath);
  if (staged === null) {
    const raw = await readFile(claimedPath, 'utf-8').catch(() => null);
    const wellFormed = raw !== null && parseStagedNativeUpdate(raw) !== null;
    if (!wellFormed && youngAtClaim) {
      // Possible in-flight publish: put the SAME inode back so the writer's
      // pending write completes it. rename can overwrite a concurrently
      // published newer record — bounded to this parse-failure window, and
      // the loser is a newer stage that simply re-downloads, never a corrupt
      // install.
      await rename(claimedPath, stateFile).catch(() => {});
      return null;
    }
    await unlink(claimedPath).catch(() => {});
    return null;
  }
  return { staged, claimedPath };
}

/**
 * Put a claimed stage's metadata back so a later launch can retry — but only
 * into a still-free state-file path: a downloader may have published a NEWER
 * stage meanwhile, and an unconditional restore would silently replace it.
 * The publish is create-if-absent (hard link, or an exclusive create on
 * filesystems without hard-link support), so the restore never overwrites.
 *
 * The claim file is removed only when the restore landed or the path was
 * taken by a newer stage (ours is superseded either way). A transient
 * failure (ENOSPC, EACCES, …) RETAINS the claim: discarding it would orphan
 * the staged exe with no newer stage to show for it, and the stale-claim
 * sweep retries the restore on a later launch.
 */
async function restoreClaimedUpdate(exePath: string, claimedPath: string): Promise<void> {
  const content = await readFile(claimedPath, 'utf-8').catch(() => null);
  if (content === null) {
    // Nothing readable to restore — drop the residue.
    await unlink(claimedPath).catch(() => {});
    return;
  }
  try {
    await createFileIfAbsent(getNativeStagedStateFile(exePath), content);
  } catch (error) {
    if (!isAlreadyExists(error)) return;
    // EEXIST: a concurrently published newer stage won the path.
  }
  await unlink(claimedPath).catch(() => {});
}

/**
 * Discard a claimed stage: only the claimed metadata file is removed — never
 * the staged exe. A same-version downloader may have just renamed its fresh
 * payload onto that path (payloads publish before their metadata), and
 * genuinely unreferenced exes are reaped by the downloader's own orphan
 * cleanup before its next stage.
 */
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

/**
 * Serialize the swap's executable-renaming critical section across CLI
 * processes. The fresh-claim sweep is only a directory SNAPSHOT: two
 * processes can both pass it before either claims, then claim different
 * stage generations and rename the same installed exe concurrently —
 * deleting or replacing each other's `.bak` rollback source. The mutex is
 * create-if-absent (via createFileIfAbsent); an aged holder is crash residue
 * (the section lasts well under a second) and is swept, then retried once.
 */
async function acquireSwapMutex(stagingDir: string): Promise<SwapMutexHandle | null> {
  const mutexPath = join(stagingDir, 'swap.lock');
  const marker = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await createFileIfAbsent(mutexPath, marker);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        // Transient IO failure (ENOSPC, EACCES, …): defer the swap rather
        // than abort it — the caller restores the claim for a later launch.
        return null;
      }
      if (attempt === 1) return null;
      // Held — or crash residue: only an AGED mutex may be swept.
      const info = await stat(mutexPath).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs <= SWAP_MUTEX_STALE_MS) return null;
      await unlink(mutexPath).catch(() => {});
      continue;
    }
    // The stale sweep races this publish; only the survivor proceeds (same
    // irreducible residual as the install lock's takeover marker).
    const published = await readFile(mutexPath, 'utf-8').catch(() => null);
    if (published !== marker) return null;
    return {
      release: async (): Promise<void> => {
        // Release only the mutex instance we own.
        const current = await readFile(mutexPath, 'utf-8').catch(() => null);
        if (current !== marker) return;
        await unlink(mutexPath).catch(() => {});
      },
    };
  }
  return null;
}

/**
 * Remove leftover `.bak` siblings of the exe from earlier swaps/installs.
 * Only names the updater itself creates are removed: the exact `<exe>.bak`
 * and the numeric PID fallback `<exe>.<pid>.bak` — anything else with the
 * prefix (`kimi.config.bak`, …) belongs to the user. A `.bak` still mapped
 * by a running old instance cannot be deleted on Windows — it is simply
 * left for a later launch.
 */
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

/**
 * Recover `staged.json.swap-<pid>` claim files left by instances that died
 * mid-swap (or kept by a restore that hit a transient error). An AGED claim
 * is restored back onto the state-file path — create-if-absent, so a newer
 * published stage is never overwritten — and this very launch can then claim
 * and retry the swap; the claim file is dropped once the record is restored
 * or superseded, and retained on transient errors. The referenced exes are
 * never touched here: they may belong to a freshly published stage, and
 * genuinely unreferenced ones are reaped by the downloader's own orphan
 * cleanup before its next stage. Returns true when a FRESH claim file was
 * seen — i.e. another instance is swapping right now.
 */
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

/**
 * Best-effort startup hygiene for update leftovers, run on every native
 * launch. The swap itself can never fully clean up after its own run — the
 * old process still holds its renamed image (`.bak`) on Windows — so later
 * launches sweep what the previous run could not.
 *
 * Returns true when another instance holds a fresh swap claim or swap mutex:
 * every artifact is then left alone and the caller must not start a second
 * swap.
 */
async function sweepStaleNativeUpdateArtifacts(exePath: string): Promise<boolean> {
  try {
    if (await cleanupStaleSwapClaims(exePath)) {
      // Another instance is mid-swap: leave every artifact alone — the `.bak`
      // next to the exe is its rollback source.
      return true;
    }
    // A live swap critical section holds the mutex: same deference. (Only a
    // snapshot, but the swap re-checks the mutex after claiming, so a
    // freshly-started swap is never entered concurrently.)
    const mutexInfo = await stat(join(getNativeStagingDir(exePath), 'swap.lock')).catch(
      () => null,
    );
    if (mutexInfo !== null && Date.now() - mutexInfo.mtimeMs <= SWAP_MUTEX_STALE_MS) {
      return true;
    }
    await cleanupBackups(exePath);
  } catch {
    // Hygiene must never affect startup.
  }
  return false;
}

/**
 * Re-exec the (newly swapped) exe with the original argv, forwarding its exit
 * code so the swap is invisible to the caller. Returns false when the spawn
 * itself failed — the caller then continues startup with the old in-memory
 * code; the binary on disk is already the new version.
 */
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
      // Terminated by a signal (OOM kill, external SIGKILL, …): mirror the
      // shell's 128 + signo convention so the wrapper never reports a killed
      // run as a successful CLI invocation.
      const signo = signal !== null ? (osConstants.signals[signal] ?? 0) : 0;
      exitImpl(signo > 0 ? 128 + signo : 1);
    });
  });
}

/**
 * Swap in a staged native update and re-exec when one is ready.
 *
 * Returns true only when the process was re-launched (the caller must not
 * continue startup — the exit handler fires once the child exits). Every
 * other outcome returns false so startup proceeds untouched.
 */
export async function maybeRelaunchWithStagedNativeUpdate(
  deps: NativeSwapDeps,
): Promise<boolean> {
  if (!deps.isNative) return false;
  const swapInProgress = await sweepStaleNativeUpdateArtifacts(deps.exePath);
  if (isTruthy(deps.env[KIMI_CODE_UPDATE_REEXEC_ENV])) {
    // Read-once guard: drop it so this session's children (and any nested
    // kimi launches from them) do not inherit the swap skip.
    delete deps.env[KIMI_CODE_UPDATE_REEXEC_ENV];
    return false;
  }
  if (swapInProgress) {
    // Another instance holds a fresh swap claim and finishes (or rolls back)
    // on its own. Starting a second swap here would rename the install path
    // from under it and let each launcher delete the `.bak` the other may
    // still need for rollback. Its re-exec — or our next launch — lands the
    // update, so this session simply runs the current exe.
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

  // Downgrade guard: the staged version must be newer than what is running.
  // (The user may have installed a newer build manually after we staged.)
  if (!gt(staged.version, deps.currentVersion)) {
    logSwap('discarding staged update (not newer)', {
      staged: staged.version,
      current: deps.currentVersion,
    });
    return discard();
  }

  // Automatic stages apply only while automatic updates are enabled — both
  // the env opt-out and the persisted `[upgrade] auto_install = false`
  // preference gate them. Evaluated on the CLAIMED metadata: a pre-claim
  // snapshot could be replaced by a downloader before the claim, smuggling an
  // automatic payload past the gate. A manually requested stage always
  // applies. When disabled, restore the claim (never overwriting a newer
  // stage) so a later launch without the opt-out can still apply it.
  if (
    staged.manual !== true &&
    (isAutoUpdateDisabledByEnv(deps.env) || !(await shouldAutoInstallUpdates()))
  ) {
    await restoreClaimedUpdate(deps.exePath, claimedPath);
    return false;
  }

  // Re-verify the staged bytes against the recorded checksum: the exe could
  // have been damaged on disk after the download verified it (corruption, a
  // non-durable interrupted write), and the `--version` smoke check alone
  // would not catch every such case. Only paid once the swap actually
  // proceeds. A mismatch discards the stage so a later cycle re-downloads
  // it — this is not a swap failure.
  const digest = await hashFileSha256(stagedExePath(deps.exePath, staged));
  if (digest !== staged.sha256) {
    logSwap('staged exe failed checksum verification, discarding', {
      version: staged.version,
    });
    return discard();
  }

  const stagedExe = stagedExePath(deps.exePath, staged);

  // 1. Smoke-check the staged exe BEFORE touching the install path: a staged
  //    binary that cannot start (or lies about its version) is discarded with
  //    the running exe never moved — the safest possible failure shape.
  if (!(await smokeCheck(stagedExe, staged, spawnImpl))) {
    logSwap('smoke check failed, discarding staged update', { version: staged.version });
    await recordSwapFailure(staged.version);
    return discard();
  }

  // The fresh-claim sweep at startup is only a directory snapshot — another
  // instance may have begun its swap after our sweep ran. Take the swap
  // mutex before touching the install path so two swaps never rename the
  // same exe concurrently (each would delete the other's `.bak` rollback
  // source). The staged payload is immutable (unique generation name), so
  // nothing validated above can change while we contend here.
  const swapMutex = await acquireSwapMutex(getNativeStagingDir(deps.exePath));
  if (swapMutex === null) {
    logSwap('another instance is in its swap critical section, deferring', {
      exePath: deps.exePath,
    });
    await restoreClaimedUpdate(deps.exePath, claimedPath);
    return false;
  }
  try {
    // 2. Pick a backup slot and move the running exe aside (rename of a running
    //    exe is legal on Windows and POSIX alike; overwriting is not).
    //
    //    Crash window: if the process dies between this rename and step 3, the
    //    install path is left empty and no CLI code can run to self-heal. Each
    //    rename is atomic, the window is two adjacent syscalls, and recovery is
    //    `mv <exe>.bak <exe>` or re-running the install script.
    let bakPath = `${deps.exePath}.bak`;
    try {
      await unlink(bakPath);
    } catch (error) {
      if (!isNotFound(error)) {
        // The leftover `.bak` is locked by a still-running old instance (or
        // undeletable for another reason) — take a unique backup name, the same
        // fallback install.ps1 uses. It is best-effort cleaned up on later runs.
        bakPath = `${deps.exePath}.${process.pid}.bak`;
      }
    }
    try {
      await rename(deps.exePath, bakPath);
    } catch (error) {
      // Nothing was moved: startup continues with the old exe. Restore the
      // claimed metadata so a later launch retries the swap (transient locks
      // clear on reboot) — but only into a still-free state-file path: a
      // downloader may have published a NEWER stage while we smoke-checked,
      // and an unconditional restore would silently replace it. The restore is
      // create-if-absent, so it can never overwrite; when the path is taken,
      // the newer stage wins and ours is discarded.
      logSwap('failed to move exe aside', { exePath: deps.exePath, error: String(error) });
      await restoreClaimedUpdate(deps.exePath, claimedPath);
      return false;
    }

    // 3. Move the staged exe into place; roll back on failure.
    if ((await rename(stagedExe, deps.exePath).catch(() => null)) === null) {
      logSwap('failed to move staged exe into place, rolling back', { exePath: deps.exePath });
      if (!(await rollback(bakPath, deps.exePath))) {
        // Rollback failed too (transient file lock, AV, …): the install path is
        // now absent and no next launch can start. Keep every artifact instead
        // of discarding — the `.bak` IS the old exe and the staged payload is a
        // second recovery copy, so `mv <exe>.bak <exe>` or re-running the
        // installer still recovers.
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

    // 4. Success: clean up, STILL INSIDE the mutex — a swap that acquires it
    //    the instant we release could rename the exe we just installed to the
    //    shared `.bak` path, and this cleanup would delete that rollback
    //    source. Then re-exec into the new binary.
    await unlink(claimedPath).catch(() => {});
    await unlink(bakPath).catch(() => {});
    await cleanupBackups(deps.exePath, bakPath);
    logSwap('swap succeeded, re-launching', { version: staged.version });
  } finally {
    await swapMutex.release();
  }
  // Cosmetic, now that the release removed our mutex file: drop the staging
  // dir when empty. And re-exec OUTSIDE the critical section: the child runs
  // the user session, so awaiting it inside the try would hold the mutex for
  // its whole lifetime.
  await rmdir(getNativeStagingDir(deps.exePath)).catch(() => {});
  return reexec({ ...deps, spawnImpl });
}
