/**
 * `kimi web ensure-daemon` — internal bootstrap for SSH Full-Remote.
 *
 * Run over `ssh` by the local bridge: reuses a healthy loopback server on this
 * machine or starts a detached one, then reports its endpoint on one
 * marker-prefixed stdout line, so shell-rc output cannot break parsing.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_PROTOCOL_VERSION, listLiveServerInstances, type ServerInstanceInfo } from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { detectNativeInstall } from '../../update/source';
import { getVersion } from '../../version';
import { isLoopbackHost } from './access-urls';
import { authHeaders, serverOrigin, tryResolveServerToken } from './shared';

export const ENSURE_DAEMON_MARKER = '__KIMI_ENSURE_DAEMON__';
export const ENSURE_DAEMON_MANAGED_BY = 'ensure-daemon';

const LOCK_FILE = 'ensure-daemon.lock';
const LOG_FILE = 'ensure-daemon.log';
const AGENT_SOCKET_FILE = 'forwarded-ssh-agent.sock';
const POLL_INTERVAL_MS = 200;
const LOCK_MAX_ATTEMPTS = 225;
const START_MAX_ATTEMPTS = 150;
const HTTP_TIMEOUT_MS = 2_000;

export type EnsureDaemonErrorCode =
  | 'lock_timeout'
  | 'start_timeout'
  | 'token_unavailable'
  | 'version_mismatch_busy';

export class EnsureDaemonError extends Error {
  constructor(
    readonly code: EnsureDaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnsureDaemonError';
  }
}

export interface EnsureDaemonResult {
  readonly port: number;
  readonly token: string;
  readonly version: string;
  readonly pid: number;
  /** Absolute path for the bridge's `ssh -R` agent forward; `ssh` does not expand `~` here. */
  readonly agentSocket: string;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  listLive(): Promise<readonly ServerInstanceInfo[]>;
  readToken(): string | undefined;
  isHealthy(origin: string): Promise<boolean>;
  /** Resolves false when the instance still has live work and must not be replaced. */
  stopIfIdle(origin: string, token: string): Promise<boolean>;
  spawnServer(logPath: string, agentSocket: string): number;
  wait(ms: number): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireLock(
  lockPath: string,
  wait: (ms: number) => Promise<void>,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if (!Number.isNaN(holder) && !pidAlive(holder)) await rm(lockPath, { force: true });
      else await wait(POLL_INTERVAL_MS);
    }
  }
  throw new EnsureDaemonError('lock_timeout', `timed out waiting for ${lockPath}`);
}

function instanceOrigin(instance: ServerInstanceInfo): string {
  return serverOrigin(instance.host, instance.port);
}

function agentSocketPath(deps: EnsureDaemonDeps): string {
  return join(deps.homeDir, 'server', AGENT_SOCKET_FILE);
}

function toResult(deps: EnsureDaemonDeps, instance: ServerInstanceInfo): EnsureDaemonResult {
  const token = deps.readToken();
  if (token === undefined || token.length === 0) {
    throw new EnsureDaemonError('token_unavailable', 'unable to read the server token');
  }
  return {
    port: instance.port,
    token,
    version: deps.version,
    pid: instance.pid,
    agentSocket: agentSocketPath(deps),
  };
}

async function retireOutdatedManaged(
  deps: EnsureDaemonDeps,
  live: readonly ServerInstanceInfo[],
): Promise<void> {
  const token = deps.readToken();
  if (token === undefined) return;
  for (const instance of live) {
    if (instance.managedBy !== ENSURE_DAEMON_MANAGED_BY || instance.serverVersion === deps.version) {
      continue;
    }
    if (!(await deps.stopIfIdle(instanceOrigin(instance), token))) {
      throw new EnsureDaemonError(
        'version_mismatch_busy',
        `a kimi server of version ${instance.serverVersion ?? 'unknown'} is still running work on this host; retry after it finishes`,
      );
    }
  }
}

async function waitForSpawned(
  deps: EnsureDaemonDeps,
  pid: number,
  logPath: string,
): Promise<ServerInstanceInfo> {
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = (await deps.listLive()).find((instance) => instance.pid === pid && instance.port > 0);
    if (started !== undefined) return started;
    await deps.wait(POLL_INTERVAL_MS);
  }
  throw new EnsureDaemonError('start_timeout', `the kimi server did not start; see ${logPath}`);
}

async function findOrStart(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const live = (await deps.listLive()).filter(
    (instance) => isLoopbackHost(instance.host) && instance.port > 0,
  );
  const reusable = live
    .filter((instance) => instance.serverVersion === deps.version)
    .toSorted((a, b) => Number(b.managedBy !== undefined) - Number(a.managedBy !== undefined));
  for (const instance of reusable) {
    if (await deps.isHealthy(instanceOrigin(instance))) return toResult(deps, instance);
  }
  await retireOutdatedManaged(deps, live);
  const logPath = join(deps.homeDir, 'server', LOG_FILE);
  const pid = deps.spawnServer(logPath, agentSocketPath(deps));
  return toResult(deps, await waitForSpawned(deps, pid, logPath));
}

export async function ensureDaemon(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const release = await acquireLock(join(deps.homeDir, 'server', LOCK_FILE), (ms) => deps.wait(ms));
  try {
    // sshd keeps the socket of a dead forward, and a stale one makes the next `ssh -R` fail.
    await rm(agentSocketPath(deps), { force: true });
    return await findOrStart(deps);
  } finally {
    await release();
  }
}

function spawnDetachedServer(logPath: string, agentSocket: string): number {
  const argv = detectNativeInstall()
    ? [process.execPath]
    : [process.execPath, ...process.execArgv, process.argv[1]!];
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w', 0o600);
  try {
    const child = spawn(
      argv[0]!,
      [
        ...argv.slice(1),
        'web',
        '--no-open',
        '--port',
        '0',
        '--log-level',
        'info',
        '--managed-by',
        ENSURE_DAEMON_MANAGED_BY,
      ],
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
      },
    );
    child.on('error', () => {});
    child.unref();
    if (child.pid === undefined) {
      throw new EnsureDaemonError('start_timeout', `unable to start the kimi server; see ${logPath}`);
    }
    return child.pid;
  } finally {
    closeSync(log);
  }
}

async function isServerHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/v1/healthz`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stopServerIfIdle(origin: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/v1/shutdown?if_idle=true`, {
      method: 'POST',
      headers: authHeaders(token),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = (await response.json()) as { data?: { ok?: boolean } };
    return body.data?.ok === true;
  } catch {
    // An unreachable instance has nothing left to protect.
    return true;
  }
}

function defaultDeps(): EnsureDaemonDeps {
  const homeDir = getDataDir();
  return {
    homeDir,
    version: getVersion(),
    listLive: () => listLiveServerInstances(homeDir),
    readToken: () => tryResolveServerToken(homeDir),
    isHealthy: isServerHealthy,
    stopIfIdle: stopServerIfIdle,
    spawnServer: spawnDetachedServer,
    wait: (ms) => sleep(ms),
  };
}

export function registerEnsureDaemonCommand(web: Command): void {
  web
    .command('ensure-daemon', { hidden: true })
    .description('Internal: reuse or start a background server and print its endpoint.')
    .option('--probe', 'Only report the host protocol and version.')
    .action(async (options: { probe?: boolean }) => {
      const report = (payload: Record<string, unknown>): void => {
        process.stdout.write(
          `${ENSURE_DAEMON_MARKER}${JSON.stringify({ protocol: HOST_PROTOCOL_VERSION, version: getVersion(), ...payload })}\n`,
        );
      };
      if (options.probe === true) {
        report({});
        return;
      }
      try {
        report({ ...(await ensureDaemon(defaultDeps())) });
      } catch (error) {
        const code = error instanceof EnsureDaemonError ? error.code : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        report({ error: code, message });
        process.exitCode = 1;
      }
    });
}
