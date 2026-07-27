/**
 * `kimi server kill` — deprecated; only stops a server started by an old
 * (pre-`kimi web`, i.e. before 0.28.0) build.
 *
 * Servers started by current builds run in the foreground attached to a
 * terminal (Ctrl+C stops them), so they need no kill command. Builds before
 * the `kimi web` command tree could leave a background daemon behind; those
 * recorded themselves in the legacy single-instance lock at
 * `<KIMI_CODE_HOME>/server/lock`, which the instance registry never sees.
 * This command is the cleanup path for exactly those servers.
 *
 * The kill combines two independent mechanisms so the server dies even if one
 * path fails:
 *
 *   1. API path  — `POST /api/v1/shutdown` for a graceful, in-process shutdown
 *                  (best-effort; old builds may not have the route, or may not
 *                  answer at all).
 *   2. PID path  — signal the pid recorded in the lock (SIGTERM → wait →
 *                  SIGKILL). SIGKILL is the hard guarantee: it cannot be
 *                  caught or ignored.
 *
 * The lock file is removed once the recorded pid is confirmed dead (or was
 * dead already), so the cleanup is complete after one run.
 */

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { authHeaders, serverOrigin, tryResolveServerToken } from './shared';

/** How long to wait for the graceful API shutdown request. */
const API_TIMEOUT_MS = 2000;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 3000;
/** Grace period after SIGKILL before giving up. */
const KILL_GRACE_MS = 2000;
/** Poll cadence while waiting for the pid to exit. */
const POLL_INTERVAL_MS = 100;

/**
 * The first release whose servers run in the foreground (`kimi web`) and
 * register under `server/instances/`. Servers from older builds are the only
 * ones this command can — and should — kill.
 */
export const LEGACY_SERVER_MAX_VERSION = '0.28.0';

/** Deprecation notice printed on every `kimi server kill` run. */
export const DEPRECATED_KILL_NOTICE =
  '`kimi server kill` is deprecated: it only stops servers started by a version before 0.28.0. Servers started by `kimi web` run in the foreground — stop them with Ctrl+C.\n';

/**
 * The fields of the legacy `<home>/server/lock` this command needs. The full
 * on-disk shape also carried `started_at` / `host_version` / `entry`, which
 * are irrelevant to killing the process.
 */
export interface LegacyServerLock {
  pid: number;
  host?: string;
  port?: number;
}

export interface LegacyKillDeps {
  /** Read and parse the legacy lock; undefined when missing or unparseable. */
  readLock(): Promise<LegacyServerLock | undefined>;
  /** Delete the lock file. Best-effort semantics live with the caller. */
  removeLock(): Promise<void>;
  requestShutdown(origin: string, token: string | undefined): Promise<void>;
  /** Best-effort read of the persistent bearer token; undefined on miss. */
  resolveToken(): string | undefined;
  signalPid(pid: number, signal: NodeJS.Signals): boolean;
  pidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  now(): number;
}

export function registerLegacyKillCommand(server: Command): void {
  server
    .command('kill')
    .description(
      'Deprecated — stop a server started by a version before 0.28.0 (recorded in the legacy server lock). Servers started by `kimi web` run in the foreground — stop them with Ctrl+C.',
    )
    // Swallow legacy argument shapes (`kimi server kill <serverId>`, flags):
    // the legacy lock records a single server, so they carry no meaning here.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async () => {
      try {
        await handleLegacyKillCommand(DEFAULT_LEGACY_KILL_DEPS);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleLegacyKillCommand(deps: LegacyKillDeps): Promise<void> {
  deps.stderr.write(DEPRECATED_KILL_NOTICE);

  const lock = await deps.readLock();
  if (lock === undefined) {
    deps.stdout.write('No running legacy Kimi server.\n');
    return;
  }

  if (!deps.pidAlive(lock.pid)) {
    // Stale lock from a server that died without releasing it; sweep it so the
    // cleanup is done in one run.
    await deps.removeLock().catch(() => {});
    deps.stdout.write('No running legacy Kimi server.\n');
    return;
  }

  const outcome = await killLegacyServer(lock, deps);
  await deps.removeLock().catch(() => {});
  deps.stdout.write(`Legacy Kimi server (pid ${String(lock.pid)}) ${outcome}.\n`);
}

/**
 * Kill the locked server via the API path (best-effort graceful shutdown)
 * followed by the PID path (SIGTERM → wait → SIGKILL). Resolves with how the
 * process went down; throws when the pid survives SIGKILL.
 */
async function killLegacyServer(
  lock: LegacyServerLock,
  deps: LegacyKillDeps,
): Promise<'stopped' | 'killed'> {
  const { pid } = lock;

  // 1. API path — best-effort graceful shutdown. Ignore every outcome: an old
  //    build may not have the route, may be wedged, or may drop the connection
  //    as it exits. The bearer token is best-effort too: if it can't be read
  //    the API call 401s and the PID path below still guarantees the kill.
  if (lock.port !== undefined) {
    const origin = serverOrigin(lock.host ?? '127.0.0.1', lock.port);
    await deps.requestShutdown(origin, deps.resolveToken()).catch(() => {});
  }

  // 2. PID path — SIGTERM, wait, then SIGKILL.
  deps.signalPid(pid, 'SIGTERM');

  if (await waitForExit(pid, TERM_GRACE_MS, deps)) {
    return 'stopped';
  }

  deps.signalPid(pid, 'SIGKILL');

  if (await waitForExit(pid, KILL_GRACE_MS, deps)) {
    return 'killed';
  }

  throw new Error(
    `Failed to stop legacy Kimi server (pid ${String(pid)}); insufficient permissions?`,
  );
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: Pick<LegacyKillDeps, 'pidAlive' | 'sleep' | 'now'>,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  do {
    if (!deps.pidAlive(pid)) return true;
    await deps.sleep(POLL_INTERVAL_MS);
  } while (deps.now() < deadline);
  return !deps.pidAlive(pid);
}

/** `process.kill(pid, 0)` probe — true if the pid exists, false on ESRCH. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it. Treat as alive.
    return true;
  }
}

/** Send `signal` to `pid`. Returns false if the signal could not be sent. */
export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** POST the shutdown endpoint; resolves once the request completes or times out. */
export async function requestShutdownViaApi(
  origin: string,
  token: string | undefined,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/v1/shutdown`, {
      method: 'POST',
      headers: token !== undefined ? authHeaders(token) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Path of the legacy single-instance lock under the CLI's data dir. */
export function legacyLockPath(homeDir: string): string {
  return join(homeDir, 'server', 'lock');
}

/** Read + decode the legacy lock; undefined on missing/unparseable input. */
export async function readLegacyLock(lockPath: string): Promise<LegacyServerLock | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<{ pid: unknown; host: unknown; port: unknown }>;
    // Only accept a positive safe-integer pid: on POSIX, 0 and negative pids
    // have process-GROUP semantics, so signaling a corrupt lock's pid could
    // hit this CLI's own group or an unrelated one.
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      host: typeof parsed.host === 'string' ? parsed.host : undefined,
      port: typeof parsed.port === 'number' ? parsed.port : undefined,
    };
  } catch {
    return undefined;
  }
}

const DEFAULT_LEGACY_KILL_DEPS: LegacyKillDeps = {
  readLock: () => readLegacyLock(legacyLockPath(getDataDir())),
  removeLock: () => unlink(legacyLockPath(getDataDir())),
  requestShutdown: requestShutdownViaApi,
  resolveToken: () => tryResolveServerToken(getDataDir()),
  signalPid,
  pidAlive,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  stdout: process.stdout,
  stderr: process.stderr,
  now: () => Date.now(),
};
