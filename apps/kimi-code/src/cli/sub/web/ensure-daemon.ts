import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
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
const IPC_TOKEN_FILE = 'ensure-daemon.token';
const IPC_TOKEN_ENV = 'KIMI_CODE_IPC_TOKEN';
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
  stopIfIdle(): Promise<boolean>;
  close(): void;
}

interface EnsureDaemonResult {
  readonly version: string;
  readonly stream: Duplex;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  readonly ipcToken?: string;
  connectSocket(socketPath: string, ipcToken?: string): Promise<DaemonConnection | undefined>;
  spawnServer(socketPath: string, logPath: string, agentSocket: string): Promise<void> | void;
  wait(ms: number): Promise<void>;
}

export function daemonSocketPath(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\kimi-daemon-${hash}`;
  }
  const direct = join(homeDir, 'server', SOCKET_FILE);
  if (Buffer.byteLength(direct) <= 100) return direct;
  const hash = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  return join(tmpdir(), `kimi-daemon-${hash}.sock`);
}

export async function loadWindowsIpcToken(homeDir: string): Promise<string> {
  const tokenPath = join(homeDir, 'server', IPC_TOKEN_FILE);
  await mkdir(dirname(tokenPath), { recursive: true });
  try {
    const handle = await open(tokenPath, 'wx', 0o600);
    try {
      const token = randomBytes(32).toString('base64url');
      await handle.writeFile(token);
      return token;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (token.length === 0) throw new Error(`empty IPC token in ${tokenPath}`);
  return token;
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
  if (process.platform === 'win32') return;
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
  const existing = await deps.connectSocket(socketPath, deps.ipcToken);
  if (existing !== undefined) {
    if (existing.version === deps.version) {
      return { version: deps.version, stream: existing.stream };
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
      const probe = await deps.connectSocket(socketPath, deps.ipcToken);
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
  await deps.spawnServer(socketPath, logPath, agentSocketPath(deps));
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = await deps.connectSocket(socketPath, deps.ipcToken);
    if (started !== undefined) {
      return { version: deps.version, stream: started.stream };
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

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function windowsDaemonLaunchScript(
  argv: readonly string[],
  logPath: string,
  ipcToken: string,
  launchPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { commandLine: string; environment: readonly string[]; cimScript: string } {
  const daemonScript = `$ErrorActionPreference = 'Stop'; & ${powerShellLiteral(argv[0]!)} ${argv.slice(1).map(powerShellLiteral).join(' ')} *> ${powerShellLiteral(logPath)}`;
  const powerShell = win32.join(env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const commandLine = `${powerShell} -NoLogo -NoProfile -NonInteractive -Command "${daemonScript}"`;
  const environment = Object.entries({ ...env, [IPC_TOKEN_ENV]: ipcToken, SSH_AUTH_SOCK: undefined })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  const cimScript = [
    `$launch = Get-Content -Raw -Encoding UTF8 -LiteralPath ${powerShellLiteral(launchPath)} | ConvertFrom-Json`,
    `$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{CreateFlags=16778240; ShowWindow=0; EnvironmentVariables=$launch.environment} -ClientOnly`,
    `$result = Invoke-CimMethod -ClassName Win32_Process -Name Create -Arguments @{CommandLine=$launch.commandLine; ProcessStartupInformation=$startup}`,
    `if ($result.ReturnValue -ne 0) { throw "kimi server failed to start with CIM error $($result.ReturnValue)" }`,
  ].join('; ');
  return { commandLine, environment, cimScript };
}

async function spawnDetachedServer(socketPath: string, logPath: string, agentSocket: string, ipcToken?: string): Promise<void> {
  const argv = [
    ...(detectNativeInstall() ? [process.execPath] : [process.execPath, ...process.execArgv, process.argv[1]!]),
    'server',
    '--socket',
    socketPath,
    '--log-level',
    'info',
    '--managed-by',
    ENSURE_DAEMON_MANAGED_BY,
  ];
  if (process.platform === 'win32') {
    if (ipcToken === undefined) throw new EnsureDaemonError('start_timeout', 'missing Windows IPC token');
    const launchPath = join(dirname(logPath), 'ensure-daemon.launch.json');
    const { commandLine, environment, cimScript } = windowsDaemonLaunchScript(argv, logPath, ipcToken, launchPath);
    await writeFile(launchPath, JSON.stringify({ commandLine, environment }), { mode: 0o600 });
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(cimScript)], {
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        }, (error, _stdout, stderr) => {
          if (error !== null) {
            reject(new EnsureDaemonError('start_timeout', `unable to start the kimi server; see ${logPath}: ${stderr.trim()}`));
            return;
          }
          resolve();
        });
      });
    } finally {
      await rm(launchPath, { force: true });
    }
    return;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'w', 0o600);
  try {
    const child = spawn(
      argv[0]!,
      argv.slice(1),
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, SSH_AUTH_SOCK: agentSocket, [IPC_TOKEN_ENV]: ipcToken },
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

function authenticateIpcClient(socket: Duplex, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (authenticated: boolean): void => {
      cleanup();
      resolve(authenticated);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, SOCKET_TIMEOUT_MS);
    const onError = (): void => {
      finish(false);
    };
    const onClose = (): void => {
      finish(false);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (buffer.length > 64 * 1024) {
        finish(false);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const frame = JSON.parse(line) as { type?: string };
        finish(frame.type === 'ipc.auth.ok');
      } catch {
        finish(false);
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(`${JSON.stringify({ type: 'ipc.auth', token })}\n`);
  });
}

export async function connectUnixSocket(socketPath: string, ipcToken?: string): Promise<DaemonConnection | undefined> {
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
  if (ipcToken !== undefined && !await authenticateIpcClient(socket, ipcToken)) {
    socket.destroy();
    throw new EnsureDaemonError('start_timeout', 'Windows IPC authentication failed');
  }
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

async function defaultDeps(): Promise<EnsureDaemonDeps> {
  const homeDir = getDataDir();
  const ipcToken = process.platform === 'win32' ? await loadWindowsIpcToken(homeDir) : undefined;
  return {
    homeDir,
    version: getVersion(),
    sshAuthSock: process.env['SSH_AUTH_SOCK'],
    ipcToken,
    connectSocket: (socketPath) => connectUnixSocket(socketPath, ipcToken),
    spawnServer: (socketPath, logPath, agentSocket) => spawnDetachedServer(socketPath, logPath, agentSocket, ipcToken),
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
          `${ENSURE_DAEMON_MARKER}${JSON.stringify({ protocol: HOST_PROTOCOL_VERSION, api_level: HOST_API_LEVEL, version: getVersion(), windows_ipc: process.platform === 'win32' ? true : undefined, ...payload })}\n`,
        );
      };
      if (options.probe === true) {
        report({});
        return;
      }
      try {
        const daemon = await ensureDaemon(await defaultDeps());
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
