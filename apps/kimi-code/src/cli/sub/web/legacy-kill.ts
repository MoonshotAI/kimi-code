import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { authHeaders, serverOrigin, tryResolveServerToken } from './shared';

const API_TIMEOUT_MS = 2000;
const TERM_GRACE_MS = 3000;
const KILL_GRACE_MS = 2000;
const POLL_INTERVAL_MS = 100;

export const LEGACY_SERVER_MAX_VERSION = '0.28.0';

export const DEPRECATED_KILL_NOTICE =
  '`kimi server kill` is deprecated: it only stops servers started by a version before 0.28.0. Use Ctrl+C to stop a foreground server.\n';

export interface LegacyServerLock {
  pid: number;
  host?: string;
  port?: number;
}

export interface LegacyKillDeps {
  readLock(): Promise<LegacyServerLock | undefined>;
  removeLock(): Promise<void>;
  requestShutdown(origin: string, token: string | undefined): Promise<void>;
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
      'Deprecated — stop a server started by a version before 0.28.0 (recorded in the legacy server lock).',
    )
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
    await deps.removeLock().catch(() => {});
    deps.stdout.write('No running legacy Kimi server.\n');
    return;
  }

  const outcome = await killLegacyServer(lock, deps);
  await deps.removeLock().catch(() => {});
  deps.stdout.write(`Legacy Kimi server (pid ${String(lock.pid)}) ${outcome}.\n`);
}

async function killLegacyServer(
  lock: LegacyServerLock,
  deps: LegacyKillDeps,
): Promise<'stopped' | 'killed'> {
  const { pid } = lock;

  if (lock.port !== undefined) {
    const origin = serverOrigin(lock.host ?? '127.0.0.1', lock.port);
    await deps.requestShutdown(origin, deps.resolveToken()).catch(() => {});
  }

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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

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

export function legacyLockPath(homeDir: string): string {
  return join(homeDir, 'server', 'lock');
}

export async function readLegacyLock(lockPath: string): Promise<LegacyServerLock | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<{ pid: unknown; host: unknown; port: unknown }>;
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
