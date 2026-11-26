import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { HOST_PROTOCOL_VERSION, KAP_VERSION } from '@moonshot-ai/kap-server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { getVersion } from '../../version';
import {
  acquireDaemonLock,
  agentSocketPath,
  daemonLockPath,
  daemonLogPath,
  daemonSocketPath,
  spawnDetachedDaemonProcess,
  syncForwardedAgentSocket,
} from './daemon-client';

export { daemonSocketPath };

const ENSURE_DAEMON_MARKER = '__KIMI_ENSURE_DAEMON__';
const POLL_INTERVAL_MS = 200;
const START_MAX_ATTEMPTS = 150;
const SOCKET_TIMEOUT_MS = 2_000;

type EnsureDaemonErrorCode = 'lock_timeout' | 'start_timeout';

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
  readonly kapVersion?: number;
  stopIfIdle(): Promise<boolean>;
  close(): void;
}

export interface EnsureDaemonResult {
  readonly version: string;
  readonly kapVersion: number;
  readonly reusedBusyMismatch: boolean;
  readonly stream: Duplex;
}

export interface EnsureDaemonDeps {
  readonly homeDir: string;
  readonly version: string;
  readonly sshAuthSock?: string;
  connectSocket(socketPath: string): Promise<DaemonConnection | undefined>;
  spawnServer(socketPath: string, logPath: string, agentSocket: string): void;
  wait(ms: number): Promise<void>;
}

async function findOrStart(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  const socketPath = daemonSocketPath(deps.homeDir);
  const existing = await deps.connectSocket(socketPath);
  if (existing !== undefined) {
    if (existing.version === deps.version) {
      return {
        version: existing.version,
        kapVersion: existing.kapVersion ?? KAP_VERSION,
        reusedBusyMismatch: false,
        stream: existing.stream,
      };
    }
    const stopped = await existing.stopIfIdle().catch(() => false);
    if (!stopped) {
      return {
        version: existing.version,
        kapVersion: existing.kapVersion ?? KAP_VERSION,
        reusedBusyMismatch: true,
        stream: existing.stream,
      };
    }
    existing.close();
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
  deps.spawnServer(socketPath, logPath, agentSocketPath(deps.homeDir));
  for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
    const started = await deps.connectSocket(socketPath);
    if (started !== undefined) {
      return {
        version: started.version,
        kapVersion: started.kapVersion ?? KAP_VERSION,
        reusedBusyMismatch: false,
        stream: started.stream,
      };
    }
    await deps.wait(POLL_INTERVAL_MS);
  }
  throw new EnsureDaemonError('start_timeout', `the kimi server did not start; see ${logPath}`);
}

export async function ensureDaemon(deps: EnsureDaemonDeps): Promise<EnsureDaemonResult> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireDaemonLock(daemonLockPath(deps.homeDir), (ms) => deps.wait(ms));
  } catch (error) {
    throw new EnsureDaemonError(
      'lock_timeout',
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    await syncForwardedAgentSocket(deps.homeDir, deps.sshAuthSock);
    return await findOrStart(deps);
  } finally {
    await release();
  }
}

function spawnDetachedServer(_socketPath: string, logPath: string, agentSocket: string): void {
  try {
    spawnDetachedDaemonProcess(getDataDir(), process.env, { logPath, agentSocket });
  } catch (error) {
    throw new EnsureDaemonError(
      'start_timeout',
      error instanceof Error ? error.message : String(error),
    );
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
  const meta = await rpcCall<{ server_version?: string; kap_version?: number }>(
    socket,
    'meta',
    'GET',
    '/api/v1/meta',
  );
  if (meta?.data?.server_version === undefined) {
    socket.destroy();
    return undefined;
  }
  return {
    stream: socket,
    version: meta.data.server_version,
    kapVersion: meta.data.kap_version ?? 1,
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
      const cliVersion = getVersion();
      const report = (payload: Record<string, unknown>): void => {
        process.stdout.write(
          `${ENSURE_DAEMON_MARKER}${JSON.stringify({
            protocol: HOST_PROTOCOL_VERSION,
            api_level: KAP_VERSION,
            kap_version: KAP_VERSION,
            version: cliVersion,
            ...payload,
          })}\n`,
        );
      };
      if (options.probe === true) {
        report({});
        return;
      }
      try {
        const daemon = await ensureDaemon(defaultDeps());
        if (daemon.reusedBusyMismatch) {
          process.stderr.write(
            `Note: Kimi daemon ${daemon.version} is still running active work; reusing it until idle.\n`,
          );
        }
        report({
          api_level: daemon.kapVersion,
          kap_version: daemon.kapVersion,
          version: daemon.version,
          ...(daemon.version !== cliVersion ? { cli_version: cliVersion } : {}),
        });
        await relayStdio(process.stdin, process.stdout, daemon.stream);
      } catch (error) {
        const code = error instanceof EnsureDaemonError ? error.code : 'unknown';
        const message = error instanceof Error ? error.message : String(error);
        report({ error: code, message });
        process.exitCode = 1;
      }
    });
}
