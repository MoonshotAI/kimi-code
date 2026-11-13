/**
 * `kimi server ensure-daemon` — internal bootstrap and stdio bridge for SSH Full-Remote.
 *
 * Run over `ssh` by the local bridge: reuses a healthy background server on this
 * machine's Unix domain socket or starts a detached one, prints one marker-prefixed
 * JSON line on stdout, and relays stdin/stdout to the Unix domain socket until EOF.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_API_LEVEL, HOST_PROTOCOL_VERSION } from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { detectNativeInstall } from '../../update/source';
import { getVersion } from '../../version';

const ENSURE_DAEMON_MARKER = '__KIMI_ENSURE_DAEMON__';
const ENSURE_DAEMON_MANAGED_BY = 'ensure-daemon';

const LOCK_FILE = 'ensure-daemon.lock';
const LOG_FILE = 'ensure-daemon.log';
const SOCKET_FILE = 'daemon.sock';
const AGENT_SOCKET_FILE = 'forwarded-ssh-agent.sock';
const POLL_INTERVAL_MS = 200;
const LOCK_MAX_ATTEMPTS = 225;
const START_MAX_ATTEMPTS = 150;
const SOCKET_TIMEOUT_MS = 2_000;

type EnsureDaemonErrorCode =
  | 'lock_timeout'
  | 'start_timeout'
  | 'version_mismatch_busy';

class EnsureDaemonError extends Error {
  constructor(
    readonly code: EnsureDaemonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnsureDaemonError';
  }
}

export interface DaemonConnection {
  readonly stream: Duplex;
  readonly version: string;
  readonly pid?: number;
  /** Resolves false when the instance still has live work and must not be replaced. */
  stopIfIdle(): Promise<boolean>;
  close(): void;
}

interface EnsureDaemonResult {
  readonly version: string;
  readonly pid?: number;
  readonly stream: Duplex;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  connectSocket(socketPath: string): Promise<DaemonConnection | undefined>;
  spawnServer(socketPath: string, logPath: string, agentSocket: string): number;
  wait(ms: number): Promise<void>;
}

export function daemonSocketPath(homeDir: string): string {
  const direct = join(homeDir, 'server', SOCKET_FILE);
  if (Buffer.byteLength(direct) <= 100) return direct;
  const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `kimi-daemon-${hash}.sock`);
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
      let written = false;
      try {
        await handle.writeFile(String(process.pid));
        written = true;
      } finally {
        await handle.close();
        if (!written) await rm(lockPath, { force: true });
      }
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if ((!Number.isNaN(holder) && !pidAlive(holder)) || (Number.isNaN(holder) && attempt > 0)) {
        await rm(lockPath, { force: true });
      } else {
        await wait(POLL_INTERVAL_MS);
      }
    }
  }
  throw new EnsureDaemonError('lock_timeout', `timed out waiting for ${lockPath}`);
}

function agentSocketPath(deps: EnsureDaemonDeps): string {
  return join(deps.homeDir, 'server', AGENT_SOCKET_FILE);
}

async function syncAgentSocket(deps: EnsureDaemonDeps): Promise<void> {
  const target = deps.sshAuthSock;
  const linkPath = agentSocketPath(deps);
  if (target === undefined || target.length === 0 || target === linkPath) return;
  await mkdir(dirname(linkPath), { recursive: true });
  const temp = `${linkPath}.${process.pid}.tmp`;
  await rm(temp, { force: true });
  await symlink(target, temp);
  await rename(temp, linkPath);
}

async function findOrStart(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const socketPath = daemonSocketPath(deps.homeDir);
  const existing = await deps.connectSocket(socketPath);
  if (existing !== undefined) {
    if (existing.version === deps.version) {
      return { version: deps.version, pid: existing.pid, stream: existing.stream };
    }
    const stopped = await existing.stopIfIdle().finally(() => existing.close());
    if (!stopped) {
      throw new EnsureDaemonError(
        'version_mismatch_busy',
        `a kimi server of version ${existing.version} is still running work on this host; retry after it finishes`,
      );
    }
    let closed = false;
    for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
      const probe = await deps.connectSocket(socketPath);
      if (probe === undefined) {
        closed = true;
        break;
      }
      probe.close();
      await deps.wait(POLL_INTERVAL_MS);
    }
    if (!closed) {
      throw new EnsureDaemonError(
        'start_timeout',
        'the previous kimi server did not shut down in time',
      );
    }
  }
  const logPath = join(deps.homeDir, 'server', LOG_FILE);
  const pid = deps.spawnServer(socketPath, logPath, agentSocketPath(deps));
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = await deps.connectSocket(socketPath);
    if (started !== undefined) {
      return { version: deps.version, pid: started.pid ?? pid, stream: started.stream };
    }
    await deps.wait(POLL_INTERVAL_MS);
  }
  throw new EnsureDaemonError('start_timeout', `the kimi server did not start; see ${logPath}`);
}

export async function ensureDaemon(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const release = await acquireLock(join(deps.homeDir, 'server', LOCK_FILE), (ms) => deps.wait(ms));
  try {
    await syncAgentSocket(deps);
    return await findOrStart(deps);
  } finally {
    await release();
  }
}

function spawnDetachedServer(socketPath: string, logPath: string, agentSocket: string): number {
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
        'server',
        '--socket',
        socketPath,
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

interface RpcResponseEnvelope {
  readonly status?: number;
  readonly body?: string;
}

function rpcCall<T>(
  socket: Duplex,
  id: string,
  method: string,
  path: string,
): Promise<{ data?: T } | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, SOCKET_TIMEOUT_MS);
    const onError = (): void => {
      cleanup();
      resolve(undefined);
    };
    const onClose = (): void => {
      cleanup();
      resolve(undefined);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      cleanup();
      try {
        const frame = JSON.parse(line) as RpcResponseEnvelope;
        if (frame.status !== 200 || typeof frame.body !== 'string') {
          resolve(undefined);
          return;
        }
        resolve(JSON.parse(Buffer.from(frame.body, 'base64').toString('utf8')) as { data?: T });
      } catch {
        resolve(undefined);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(
      `${JSON.stringify({ type: 'http.req', id, method, path, headers: { host: '127.0.0.1' } })}\n`,
    );
  });
}

async function connectUnixSocket(socketPath: string): Promise<DaemonConnection | undefined> {
  const socket = await new Promise<Duplex | undefined>((resolve) => {
    const client = createConnection(socketPath);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(undefined);
    }, SOCKET_TIMEOUT_MS);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', () => {
      clearTimeout(timer);
      client.destroy();
      resolve(undefined);
    });
  });
  if (socket === undefined) return undefined;
  const meta = await rpcCall<{ server_version?: string }>(socket, 'meta', 'GET', '/api/v1/meta');
  if (meta?.data?.server_version === undefined) {
    socket.destroy();
    return undefined;
  }
  return {
    stream: socket,
    version: meta.data.server_version,
    stopIfIdle: async () => {
      const res = await rpcCall<{ ok?: boolean }>(
        socket,
        'stop',
        'POST',
        '/api/v1/shutdown?if_idle=true',
      );
      return res?.data?.ok === true;
    },
    close: () => {
      socket.destroy();
    },
  };
}

function relayStdio(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stream: Duplex,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.unpipe(stream);
      stream.unpipe(stdout);
      stream.destroy();
      resolve();
    };
    stream.on('close', finish);
    stream.on('error', finish);
    stdin.on('end', finish);
    stdin.on('close', finish);
    stdin.on('error', finish);
    stdout.on('error', finish);
    stdin.pipe(stream);
    stream.pipe(stdout, { end: false });
  });
}

function defaultDeps(): EnsureDaemonDeps {
  const homeDir = getDataDir();
  return {
    homeDir,
    version: getVersion(),
    sshAuthSock: process.env['SSH_AUTH_SOCK'],
    connectSocket: connectUnixSocket,
    spawnServer: spawnDetachedServer,
    wait: (ms) => sleep(ms),
  };
}

export function registerEnsureDaemonCommand(web: Command): void {
  web
    .command('ensure-daemon', { hidden: true })
    .description('Internal: reuse or start a background server and bridge stdio to its socket.')
    .option('--probe', 'Only report the host protocol and version.')
    .action(async (options: { probe?: boolean }) => {
      const report = (payload: Record<string, unknown>): void => {
        process.stdout.write(
          `${ENSURE_DAEMON_MARKER}${JSON.stringify({ protocol: HOST_PROTOCOL_VERSION, api_level: HOST_API_LEVEL, version: getVersion(), ...payload })}\n`,
        );
      };
      if (options.probe === true) {
        report({});
        return;
      }
      try {
        const daemon = await ensureDaemon(defaultDeps());
        report({ pid: daemon.pid });
        await relayStdio(process.stdin, process.stdout, daemon.stream);
      } catch (error) {
        const code = error instanceof EnsureDaemonError ? error.code : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        report({ error: code, message });
        process.exitCode = 1;
      }
    });
}
