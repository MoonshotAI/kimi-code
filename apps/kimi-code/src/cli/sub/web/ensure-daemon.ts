import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  HOST_API_LEVEL,
  HOST_PROTOCOL_VERSION,
  listLiveServerInstances,
  type ServerInstanceInfo,
} from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { detectNativeInstall } from '../../update/source';
import { getVersion } from '../../version';
import { LOCAL_SERVER_HOST, serverOrigin } from './shared';

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
  | 'web_listener_unavailable'
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

export interface DaemonEnvelope<T> {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: T | null;
  readonly details?: unknown;
}

export interface DaemonConnection {
  readonly stream: Duplex;
  readonly version: string;
  readonly serverId: string;
  request<T>(method: string, path: string, body?: unknown): Promise<DaemonEnvelope<T> | undefined>;
  stopIfIdle(): Promise<boolean>;
  close(): void;
}

export interface WebDaemon {
  readonly origin: string;
  readonly pid: number;
  readonly logPath: string;
  readonly connection: DaemonConnection;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  connectSocket(socketPath: string): Promise<DaemonConnection | undefined>;
  spawnServer(socketPath: string, logPath: string, agentSocket: string): void;
  wait(ms: number): Promise<void>;
}

export function daemonLogPath(homeDir: string): string {
  return join(homeDir, 'server', LOG_FILE);
}

export function daemonSocketPath(homeDir: string, legacyFallback = false): string {
  const direct = join(homeDir, 'server', SOCKET_FILE);
  if (Buffer.byteLength(direct) <= 100) return direct;
  const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  if (legacyFallback) return join(tmpdir(), `kimi-daemon-${hash}.sock`);
  return join(tmpdir(), `kimi-${hash}`, 'd.sock');
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

async function connectExisting(
  deps: Pick<EnsureDaemonDeps, 'homeDir' | 'connectSocket'>,
): Promise<{ socketPath: string; connection: DaemonConnection } | undefined> {
  const socketPath = daemonSocketPath(deps.homeDir);
  const connection = await deps.connectSocket(socketPath);
  if (connection !== undefined) return { socketPath, connection };
  const legacyPath = daemonSocketPath(deps.homeDir, true);
  if (legacyPath === socketPath) return undefined;
  const legacySocket = await lstat(legacyPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!legacySocket?.isSocket() || legacySocket.uid !== process.getuid?.()) return undefined;
  const legacy = await deps.connectSocket(legacyPath);
  return legacy === undefined ? undefined : { socketPath: legacyPath, connection: legacy };
}

async function waitForSocketClosed(
  deps: Pick<EnsureDaemonDeps, 'connectSocket' | 'wait'>,
  socketPath: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const probe = await deps.connectSocket(socketPath);
    if (probe === undefined) return true;
    probe.close();
    await deps.wait(POLL_INTERVAL_MS);
  }
  return false;
}

async function findOrStart(
  deps: EnsureDaemonDeps,
  socketPath: string,
  requireWebListener: boolean,
): Promise<DaemonConnection> {
  const found = await connectExisting(deps);
  if (found !== undefined) {
    const existing = found.connection;
    const sameVersion = existing.version === deps.version;
    if (sameVersion && (!requireWebListener || existing.serverId !== 'socket')) {
      return existing;
    }
    const stopped = await existing.stopIfIdle().finally(() => existing.close());
    if (!stopped) {
      if (sameVersion) {
        throw new EnsureDaemonError(
          'web_listener_unavailable',
          'the running SSH daemon has no Web listener and is still busy; retry after it finishes',
        );
      }
      throw new EnsureDaemonError(
        'version_mismatch_busy',
        `a kimi server of version ${existing.version} is still running work on this host; retry after it finishes`,
      );
    }
    if (!(await waitForSocketClosed(deps, found.socketPath))) {
      throw new EnsureDaemonError(
        'start_timeout',
        'the previous kimi server did not shut down in time',
      );
    }
  }
  const logPath = daemonLogPath(deps.homeDir);
  deps.spawnServer(socketPath, logPath, agentSocketPath(deps));
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = await deps.connectSocket(socketPath);
    if (started !== undefined) {
      return started;
    }
    await deps.wait(POLL_INTERVAL_MS);
  }
  throw new EnsureDaemonError('start_timeout', `the kimi server did not start; see ${logPath}`);
}

export async function ensureDaemon(deps: EnsureDaemonDeps, requireWebListener = false): Promise<DaemonConnection> {
  const release = await prepareDaemonLock(deps);
  try {
    await syncAgentSocket(deps);
    return await findOrStart(deps, daemonSocketPath(deps.homeDir), requireWebListener);
  } finally {
    await release();
  }
}

async function prepareDaemonLock(deps: EnsureDaemonDeps): Promise<() => Promise<void>> {
  const socketPath = daemonSocketPath(deps.homeDir);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const socketDir = dirname(socketPath);
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    const info = await lstat(socketDir);
    if (!info.isDirectory() || info.uid !== uid) {
      throw new Error(`Kimi daemon socket directory must be owned by the current user: ${socketDir}`);
    }
    if ((info.mode & 0o777) !== 0o700) await chmod(socketDir, 0o700);
  }
  return acquireLock(join(deps.homeDir, 'server', LOCK_FILE), (ms) => deps.wait(ms));
}

async function findWebInstance(
  homeDir: string,
  serverId: string,
): Promise<ServerInstanceInfo | undefined> {
  const instances = await listLiveServerInstances(homeDir);
  const instance = instances.find((entry) => entry.serverId === serverId);
  return instance === undefined || instance.host !== LOCAL_SERVER_HOST || instance.port <= 0
    ? undefined
    : instance;
}

export async function ensureWebDaemon(deps: EnsureDaemonDeps = defaultDeps()): Promise<WebDaemon> {
  const connection = await ensureDaemon(deps, true);
  try {
    const instance = await findWebInstance(deps.homeDir, connection.serverId);
    if (instance === undefined) {
      throw new EnsureDaemonError('web_listener_unavailable', 'the Kimi daemon has no registered local Web listener');
    }
    return {
      origin: serverOrigin(instance.host, instance.port),
      pid: instance.pid,
      logPath: daemonLogPath(deps.homeDir),
      connection,
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

export interface SharedDaemonStatus {
  readonly running: boolean;
  readonly log: string;
  readonly socket?: string;
  readonly version?: string;
  readonly server_id?: string;
  readonly pid?: number;
  readonly origin?: string;
  readonly remote_control?: { readonly state: string; readonly url?: string };
}

export async function inspectSharedDaemon(
  deps: Pick<EnsureDaemonDeps, 'homeDir' | 'connectSocket'> = defaultDeps(),
): Promise<SharedDaemonStatus> {
  const log = daemonLogPath(deps.homeDir);
  const found = await connectExisting(deps);
  if (found === undefined) return { running: false, log };
  const { connection, socketPath } = found;
  try {
    const instance = await findWebInstance(deps.homeDir, connection.serverId);
    const remoteControl =
      (await connection.request<{ state: string; url?: string }>('GET', '/api/v1/remote-control'))?.data ?? undefined;
    return {
      running: true,
      log,
      socket: socketPath,
      version: connection.version,
      server_id: connection.serverId,
      pid: instance?.pid,
      origin: instance === undefined ? undefined : serverOrigin(instance.host, instance.port),
      remote_control:
        remoteControl === undefined ? undefined : { state: remoteControl.state, url: remoteControl.url },
    };
  } finally {
    connection.close();
  }
}

export type StopSharedDaemonResult = 'not_running' | 'stopped' | 'busy' | 'timeout';

export async function stopSharedDaemon(
  force: boolean,
  deps: EnsureDaemonDeps = defaultDeps(),
): Promise<StopSharedDaemonResult> {
  const release = await prepareDaemonLock(deps);
  try {
    const found = await connectExisting(deps);
    if (found === undefined) return 'not_running';
    const { connection } = found;
    const accepted = await (force
      ? connection.request<{ ok?: boolean }>('POST', '/api/v1/shutdown').then((res) => res?.data?.ok === true)
      : connection.stopIfIdle()
    ).finally(() => connection.close());
    if (!accepted) return 'busy';
    return (await waitForSocketClosed(deps, found.socketPath)) ? 'stopped' : 'timeout';
  } finally {
    await release();
  }
}

export function formatSharedDaemonStatus(status: SharedDaemonStatus): string {
  if (!status.running) return `No shared Kimi server is running.\n  Logs:     ${status.log}\n`;
  const rc = status.remote_control;
  return [
    'Shared Kimi server is running.',
    `  Version:  ${status.version ?? 'unknown'}`,
    `  PID:      ${status.pid === undefined ? 'unknown' : String(status.pid)}`,
    `  Web:      ${status.origin ?? 'not available (SSH only)'}`,
    `  Socket:   ${status.socket ?? 'unknown'}`,
    `  Logs:     ${status.log}`,
    `  Remote:   ${rc === undefined ? 'unknown' : rc.url === undefined ? rc.state : `${rc.state}  ${rc.url}`}`,
    '',
  ].join('\n');
}

const STOP_MESSAGES: Record<StopSharedDaemonResult, string> = {
  not_running: 'No shared Kimi server is running.',
  stopped: 'Stopped the shared Kimi server.',
  busy: 'The shared Kimi server is still in use (running tasks, connected clients or Remote Control). Close them, or run `kimi web stop --force` to stop it anyway.',
  timeout: 'The shared Kimi server accepted the stop request but did not exit in time.',
};

export function registerSharedDaemonCommands(web: Command): void {
  web
    .command('status')
    .description('Show the shared background server used by `kimi web`, `kimi rc` and SSH connections.')
    .option('--json', 'Print the status as a single JSON object.', false)
    .action(async (options: { json?: boolean }) => {
      const status = await inspectSharedDaemon();
      process.stdout.write(options.json === true ? `${JSON.stringify(status)}\n` : formatSharedDaemonStatus(status));
    });
  web
    .command('stop')
    .description('Stop the shared background server once it is idle.')
    .option('--force', 'Stop it even while tasks are running, clients are connected or Remote Control is on.', false)
    .option('--json', 'Print the result as a single JSON object.', false)
    .action(async (options: { force?: boolean; json?: boolean }) => {
      const result = await stopSharedDaemon(options.force === true);
      const failed = result === 'busy' || result === 'timeout';
      if (options.json === true) process.stdout.write(`${JSON.stringify({ result })}\n`);
      else (failed ? process.stderr : process.stdout).write(`${STOP_MESSAGES[result]}\n`);
      if (failed) process.exitCode = 1;
    });
}

function spawnDetachedServer(socketPath: string, logPath: string, agentSocket: string): void {
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
        ...(process.platform === 'win32' ? [] : ['--also-listen-tcp']),
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
  body?: unknown,
): Promise<DaemonEnvelope<T> | undefined> {
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
        resolve(JSON.parse(Buffer.from(frame.body, 'base64').toString('utf8')) as DaemonEnvelope<T>);
      } catch {
        resolve(undefined);
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    const payload =
      body === undefined
        ? { headers: { host: '127.0.0.1' } }
        : {
            headers: { host: '127.0.0.1', 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(body)).toString('base64'),
          };
    socket.write(`${JSON.stringify({ type: 'http.req', id, method, path, ...payload })}\n`);
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
  let nextId = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const request = <T>(method: string, path: string, body?: unknown): Promise<DaemonEnvelope<T> | undefined> => {
    nextId += 1;
    const id = `cli-${String(nextId)}`;
    const run = pending.then(() => rpcCall<T>(socket, id, method, path, body));
    pending = run;
    return run;
  };
  const meta = await request<{ server_version?: string; server_id?: string }>('GET', '/api/v1/meta');
  if (meta?.data?.server_version === undefined || meta.data.server_id === undefined) {
    socket.destroy();
    return undefined;
  }
  return {
    stream: socket,
    version: meta.data.server_version,
    serverId: meta.data.server_id,
    request,
    stopIfIdle: async () => {
      const res = await request<{ ok?: boolean }>('POST', '/api/v1/shutdown?if_idle=true');
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
        report({});
        await relayStdio(process.stdin, process.stdout, daemon.stream);
      } catch (error) {
        const code = error instanceof EnsureDaemonError ? error.code : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        report({ error: code, message });
        process.exitCode = 1;
      }
    });
}
