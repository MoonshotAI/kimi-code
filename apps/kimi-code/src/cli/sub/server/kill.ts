/**
 * `kimi server kill` — terminate the running server.
 *
 * Combines two independent mechanisms so the server dies even if one path
 * fails:
 *
 *   1. API path  — `POST /api/v1/shutdown` for a graceful, in-process shutdown
 *                  (best-effort; older builds or a wedged server may not answer).
 *   2. PID path  — signal the pid recorded in the lock (SIGTERM → wait →
 *                  SIGKILL). SIGKILL / TerminateProcess is the hard guarantee:
 *                  it cannot be caught or ignored.
 *
 * The only honest failure mode is insufficient permissions (a process owned by
 * another user), which surfaces as an error rather than a silent miss.
 */

import type { Command } from 'commander';

import { getLiveLock, type LockContents } from '@moonshot-ai/server';

import { lockConnectHost } from './daemon';
import { serverOrigin } from './shared';

/** How long to wait for the graceful API shutdown request. */
const API_TIMEOUT_MS = 2000;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 3000;
/** Grace period after SIGKILL before giving up. */
const KILL_GRACE_MS = 2000;
/** Poll cadence while waiting for the pid to exit. */
const POLL_INTERVAL_MS = 100;

export interface KillCommandDeps {
  getLiveLock(): LockContents | undefined;
  requestShutdown(origin: string): Promise<void>;
  signalPid(pid: number, signal: NodeJS.Signals): boolean;
  pidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  now(): number;
}

export function registerKillCommand(server: Command): void {
  server
    .command('kill')
    .description('Stop the running Kimi server (graceful API + forced PID kill).')
    .action(async () => {
      try {
        await handleKillCommand(DEFAULT_KILL_DEPS);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleKillCommand(deps: KillCommandDeps): Promise<void> {
  const lock = deps.getLiveLock();
  if (!lock) {
    deps.stdout.write('No running Kimi server.\n');
    return;
  }

  const { pid } = lock;
  const origin = serverOrigin(lockConnectHost(lock), lock.port);

  // 1. API path — best-effort graceful shutdown. Ignore every outcome: the
  //    server may be an older build without the route, already wedged, or may
  //    drop the connection as it exits.
  await deps.requestShutdown(origin).catch(() => {});

  // 2. PID path — SIGTERM, wait, then SIGKILL.
  deps.signalPid(pid, 'SIGTERM');

  if (await waitForExit(pid, TERM_GRACE_MS, deps)) {
    deps.stdout.write(`Kimi server (pid ${String(pid)}) stopped.\n`);
    return;
  }

  deps.signalPid(pid, 'SIGKILL');

  if (await waitForExit(pid, KILL_GRACE_MS, deps)) {
    deps.stdout.write(`Kimi server (pid ${String(pid)}) killed.\n`);
    return;
  }

  throw new Error(
    `Failed to stop Kimi server (pid ${String(pid)}); insufficient permissions?`,
  );
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  deps: Pick<KillCommandDeps, 'pidAlive' | 'sleep' | 'now'>,
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
export async function requestShutdownViaApi(origin: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, API_TIMEOUT_MS);
  try {
    await fetch(`${origin}/api/v1/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_KILL_DEPS: KillCommandDeps = {
  getLiveLock,
  requestShutdown: requestShutdownViaApi,
  signalPid,
  pidAlive,
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  stdout: process.stdout,
  now: () => Date.now(),
};
