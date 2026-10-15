import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const HEARTBEAT_MAX_AGE_MS = 45_000;
export const HEALTH_PATH = '/api/v1/healthz';

const LOG_RING_MAX_LINES = 50;

export interface LiveInstance {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
}

export interface SpawnedServer {
  readonly child: ChildProcess;
  logTail(): string;
}

export interface EnsureServerOptions {
  readonly serverUrl?: string;
  readonly serverToken?: string;
  readonly cliPath?: string;
  readonly home?: string;
  readonly healthTimeoutMs?: number;
}

export interface EnsuredServer {
  readonly origin: string;
  readonly token?: string;
  readonly spawned?: SpawnedServer;
}

interface InstanceFile {
  readonly server_id?: unknown;
  readonly pid?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
  readonly heartbeat_at?: unknown;
}

export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['KIMI_CODE_HOME'];
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homedir(), '.kimi-code');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function fetchOk(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConnectHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
}

export async function discoverLiveInstance(
  home: string = resolveKimiHome(),
): Promise<LiveInstance | undefined> {
  const dir = join(home, 'server', 'instances');
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .toSorted();
  } catch {
    return undefined;
  }
  const now = Date.now();
  for (const name of names) {
    let parsed: InstanceFile;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as InstanceFile;
    } catch {
      continue;
    }
    const { pid, host, port, heartbeat_at: heartbeatAt, server_id: serverId } = parsed;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof port !== 'number') {
      continue;
    }
    if (typeof heartbeatAt !== 'number' || now - heartbeatAt > HEARTBEAT_MAX_AGE_MS) {
      continue;
    }
    if (!pidAlive(pid)) {
      continue;
    }
    const connectHost = normalizeConnectHost(host);
    if (await fetchOk(`http://${connectHost}:${port}${HEALTH_PATH}`, 1_000)) {
      return {
        serverId: typeof serverId === 'string' ? serverId : name.replace(/\.json$/, ''),
        pid,
        host: connectHost,
        port,
      };
    }
  }
  return undefined;
}

export function findKimiBinary(
  configPath?: string,
  home: string = resolveKimiHome(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configPath !== undefined && configPath.length > 0 && existsSync(configPath)) {
    return configPath;
  }
  const names = process.platform === 'win32' ? ['kimi.cmd', 'kimi.exe', 'kimi'] : ['kimi'];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const bundled = join(home, 'bin', 'kimi');
  return existsSync(bundled) ? bundled : undefined;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address !== 'object') {
        server.close();
        reject(new Error('failed to allocate a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

export function spawnServer(binary: string, port: number): SpawnedServer {
  const child = spawn(binary, ['web', '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  const ring: string[] = [];
  const push = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      ring.push(line);
      if (ring.length > LOG_RING_MAX_LINES) {
        ring.shift();
      }
    }
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  return { child, logTail: () => ring.join('\n') };
}

export async function waitForHealth(origin: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fetchOk(`${origin}${HEALTH_PATH}`, 1_000)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`server at ${origin} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
  }
}

export function readToken(home: string = resolveKimiHome()): string | undefined {
  try {
    const token = readFileSync(join(home, 'server.token'), 'utf8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureServer(opts: EnsureServerOptions = {}): Promise<EnsuredServer> {
  const home = opts.home ?? resolveKimiHome();
  const external = opts.serverUrl?.trim();
  if (external !== undefined && external.length > 0) {
    const configuredToken = opts.serverToken?.trim();
    return {
      origin: external.replace(/\/+$/, ''),
      token:
        configuredToken !== undefined && configuredToken.length > 0
          ? configuredToken
          : readToken(home),
    };
  }
  const live = await discoverLiveInstance(home);
  if (live !== undefined) {
    return { origin: `http://${live.host}:${live.port}`, token: readToken(home) };
  }
  const binary = findKimiBinary(opts.cliPath, home);
  if (binary === undefined) {
    throw new Error(
      'kimi CLI not found: set kimi.cliPath, put kimi on PATH, or install it under <kimi-home>/bin/kimi',
    );
  }
  const port = await pickFreePort();
  const spawned = spawnServer(binary, port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(origin, opts.healthTimeoutMs ?? 30_000);
  } catch (error) {
    spawned.child.kill();
    const tail = spawned.logTail();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(tail.length > 0 ? `${message}\n${tail}` : message, { cause: error });
  }
  return { origin, token: readToken(home), spawned };
}
