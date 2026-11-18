import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, symlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  DEVICE_API_LEVEL,
  DEVICE_PROTOCOL_VERSION,
  SERVER_UPGRADED_CLOSE_CODE,
  type HostCommandResult,
} from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { detectNativeInstall } from '../../update/source';
import { getVersion } from '../../version';

const ENSURE_DAEMON_MARKER = '__KIMI_ENSURE_DAEMON__';
const ENSURE_DAEMON_MANAGED_BY = 'ensure-daemon';

const LOCK_FILE = 'ensure-daemon.lock';
const LOG_FILE = 'ensure-daemon.log';
const UPGRADE_LOG_FILE = 'upgrade.log';
const COMMAND_OUTPUT_TAIL_BYTES = 16 * 1024;
const SOCKET_FILE = 'daemon.sock';
const AGENT_SOCKET_FILE = 'forwarded-ssh-agent.sock';
const POLL_INTERVAL_MS = 200;
const LOCK_MAX_ATTEMPTS = 225;
const START_MAX_ATTEMPTS = 150;
const SOCKET_TIMEOUT_MS = 2_000;
const LEASE_STREAM_ID = 'lease';
const LEASE_READY_REQUEST_ID = 'lease-ready';
const LEASE_PONG = JSON.stringify({ type: 'pong' });

type EnsureDaemonErrorCode =
  | 'lock_timeout'
  | 'start_timeout'
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

export class DaemonBusyError extends EnsureDaemonError {
  constructor(readonly runningVersion: string) {
    super(
      'version_mismatch_busy',
      `a kimi server of version ${runningVersion} is still running work on this device; retry after it finishes`,
    );
    this.name = 'DaemonBusyError';
  }
}

export interface DaemonConnection {
  readonly stream: Duplex;
  readonly version: string;
  stopIfIdle(): Promise<boolean>;
  close(): void;
}

export type DaemonExit = 'stopped' | 'upgraded';

export interface DaemonLease {
  readonly closed: Promise<DaemonExit>;
  close(): void;
}

export interface AttachedDaemon {
  readonly socketPath: string;
  readonly logPath: string;
  readonly lease: DaemonLease;
}

interface EnsureDaemonResult {
  readonly version: string;
  readonly stream: Duplex;
}

interface FoundDaemon {
  readonly socketPath: string;
  readonly connection: DaemonConnection;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  connectSocket(socketPath: string): Promise<DaemonConnection | undefined>;
  leaseSocket(socketPath: string): Promise<DaemonLease | undefined>;
  spawnServer(socketPath: string, logPath: string, agentSocket: string): void;
  wait(ms: number): Promise<void>;
}

export function daemonSocketPath(homeDir: string): string {
  const direct = join(homeDir, 'server', SOCKET_FILE);
  if (Buffer.byteLength(direct) <= 100) return direct;
  const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `kimi-daemon-${hash}.sock`);
}

export function daemonLogPath(homeDir: string): string {
  return join(homeDir, 'server', LOG_FILE);
}

export function daemonUpgradeLogPath(homeDir: string): string {
  return join(homeDir, 'server', UPGRADE_LOG_FILE);
}

export function supportsBackgroundServer(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
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

async function findOrStart(deps: EnsureDaemonDeps): Promise<FoundDaemon> {
  const socketPath = daemonSocketPath(deps.homeDir);
  const existing = await deps.connectSocket(socketPath);
  if (existing !== undefined) {
    if (existing.version === deps.version) {
      return { socketPath, connection: existing };
    }
    const stopped = await existing.stopIfIdle().finally(() => existing.close());
    if (!stopped) throw new DaemonBusyError(existing.version);
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
  const logPath = daemonLogPath(deps.homeDir);
  deps.spawnServer(socketPath, logPath, agentSocketPath(deps));
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = await deps.connectSocket(socketPath);
    if (started !== undefined) {
      return { socketPath, connection: started };
    }
    await deps.wait(POLL_INTERVAL_MS);
  }
  throw new EnsureDaemonError('start_timeout', `the kimi server did not start; see ${logPath}`);
}

async function withDaemon<T>(
  deps: EnsureDaemonDeps,
  use: (daemon: FoundDaemon) => Promise<T>,
): Promise<T> {
  const release = await acquireLock(join(deps.homeDir, 'server', LOCK_FILE), (ms) => deps.wait(ms));
  try {
    await syncAgentSocket(deps);
    return await use(await findOrStart(deps));
  } finally {
    await release();
  }
}

export function ensureDaemon(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  return withDaemon(deps, async ({ connection }) => ({ version: deps.version, stream: connection.stream }));
}

export function attachDaemon(deps: EnsureDaemonDeps): Promise<AttachedDaemon> {
  return withDaemon(deps, async ({ socketPath, connection }) => {
    connection.close();
    const logPath = daemonLogPath(deps.homeDir);
    const lease = await deps.leaseSocket(socketPath);
    if (lease === undefined) {
      throw new Error(`the kimi server stopped before Remote Control could attach to it; see ${logPath}`);
    }
    return { socketPath, logPath, lease };
  });
}

export function kimiArgv(): string[] {
  return detectNativeInstall()
    ? [process.execPath]
    : [process.execPath, ...process.execArgv, process.argv[1]!];
}

export function runKimiCommand(args: readonly string[]): Promise<HostCommandResult> {
  return runLoggedCommand([...kimiArgv(), ...args], daemonUpgradeLogPath(getDataDir()));
}

export async function runLoggedCommand(argv: readonly string[], logPath: string): Promise<HostCommandResult> {
  const { child, offset } = spawnLogged(argv, logPath);
  const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  const output = await readLogTail(logPath, offset);
  return { code: exit.code, output: exit.error === undefined ? output : `${output}${exit.error.message}\n` };
}

function spawnLogged(argv: readonly string[], logPath: string): { readonly child: ChildProcess; readonly offset: number } {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a', 0o600);
  try {
    const offset = fstatSync(log).size;
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return { child, offset };
  } finally {
    closeSync(log);
  }
}

async function readLogTail(logPath: string, offset: number): Promise<string> {
  const handle = await open(logPath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(offset, size - COMMAND_OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.max(0, size - start));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function spawnDetachedServer(socketPath: string, logPath: string, agentSocket: string): void {
  const argv = kimiArgv();
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
  } finally {
    closeSync(log);
  }
}

interface RpcFrameEnvelope {
  readonly type?: string;
  readonly id?: string;
  readonly status?: number;
  readonly code?: number;
  readonly body?: string;
  readonly data?: string;
}

function writeRpcFrame(socket: Duplex, frame: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function parseRpcFrame(line: string): RpcFrameEnvelope | undefined {
  try {
    return JSON.parse(line) as RpcFrameEnvelope;
  } catch {
    return undefined;
  }
}

function isPingMessage(data: string | undefined): boolean {
  if (data === undefined) return false;
  try {
    return (JSON.parse(data) as { type?: unknown }).type === 'ping';
  } catch {
    return false;
  }
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
        const frame = JSON.parse(line) as RpcFrameEnvelope;
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
    writeRpcFrame(socket, { type: 'http.req', id, method, path, headers: { host: '127.0.0.1' } });
  });
}

function openUnixSocket(socketPath: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
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
}

async function connectUnixSocket(socketPath: string): Promise<DaemonConnection | undefined> {
  const socket = await openUnixSocket(socketPath);
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

async function leaseUnixSocket(socketPath: string): Promise<DaemonLease | undefined> {
  const socket = await openUnixSocket(socketPath);
  if (socket === undefined) return undefined;
  let exit: DaemonExit = 'stopped';
  const closed = new Promise<DaemonExit>((resolve) => {
    socket.once('close', () => resolve(exit));
  });
  const ready = new Promise<boolean>((resolve) => {
    const settle = (attached: boolean): void => {
      clearTimeout(timer);
      resolve(attached);
    };
    const timer = setTimeout(() => settle(false), SOCKET_TIMEOUT_MS);
    void closed.then(() => settle(false));
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
      const frame = parseRpcFrame(line);
      if (frame?.type === 'http.res' && frame.id === LEASE_READY_REQUEST_ID) {
        settle(frame.status === 200);
      } else if (frame?.type === 'ws.msg' && frame.id === LEASE_STREAM_ID && isPingMessage(frame.data)) {
        writeRpcFrame(socket, { type: 'ws.msg', id: LEASE_STREAM_ID, data: LEASE_PONG });
      } else if (frame?.type === 'ws.close' && frame.id === LEASE_STREAM_ID) {
        if (frame.code === SERVER_UPGRADED_CLOSE_CODE) exit = 'upgraded';
        socket.destroy();
      }
    });
  });
  writeRpcFrame(socket, { type: 'ws.open', id: LEASE_STREAM_ID, path: '/api/v1/ws' });
  writeRpcFrame(socket, {
    type: 'http.req',
    id: LEASE_READY_REQUEST_ID,
    method: 'GET',
    path: '/api/v1/healthz',
    headers: { host: '127.0.0.1' },
  });
  if (!(await ready)) {
    socket.destroy();
    return undefined;
  }
  return {
    closed,
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

export function defaultEnsureDaemonDeps(): EnsureDaemonDeps {
  const homeDir = getDataDir();
  return {
    homeDir,
    version: getVersion(),
    sshAuthSock: process.env['SSH_AUTH_SOCK'],
    connectSocket: connectUnixSocket,
    leaseSocket: leaseUnixSocket,
    spawnServer: spawnDetachedServer,
    wait: (ms) => sleep(ms),
  };
}

export function registerEnsureDaemonCommand(web: Command): void {
  web
    .command('ensure-daemon', { hidden: true })
    .description('Internal: reuse or start a background server and bridge stdio to its socket.')
    .option('--probe', 'Only report the device protocol and version.')
    .action(async (options: { probe?: boolean }) => {
      const report = (payload: Record<string, unknown>): void => {
        process.stdout.write(
          `${ENSURE_DAEMON_MARKER}${JSON.stringify({ protocol: DEVICE_PROTOCOL_VERSION, api_level: DEVICE_API_LEVEL, version: getVersion(), ...payload })}\n`,
        );
      };
      if (options.probe === true) {
        report({});
        return;
      }
      try {
        const daemon = await ensureDaemon(defaultEnsureDaemonDeps());
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
