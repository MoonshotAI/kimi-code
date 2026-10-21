import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Plugin } from 'vite';

export const SERVER_DISCOVERY_ENDPOINT = '/__inspect/servers';

export type DiscoveredServerSource = 'instance' | 'lock' | 'proxy';

export interface DiscoveredServerInfo {
  readonly id: string;
  readonly url: string;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly hostVersion?: string;
  readonly source: DiscoveredServerSource;
}

export interface ServerDiscoveryPayload {
  readonly home: string;
  readonly token?: string;
  readonly servers: readonly DiscoveredServerInfo[];
}

interface ServerInstanceDisk {
  server_id?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  host_version?: string;
}

interface ServerLockDisk {
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  host_version?: string;
}

export function resolveKimiHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['KIMI_CODE_HOME'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.kimi-code');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function normalizeHost(host: string | undefined): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

function toUrl(host: string | undefined, port: number): string {
  return `http://${normalizeHost(host)}:${port}`;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function readLiveInstances(homeDir: string): Promise<readonly DiscoveredServerInfo[]> {
  const instancesDir = join(homeDir, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch {
    return [];
  }
  const live: { started_at: number; info: DiscoveredServerInfo }[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const disk = await readJson<ServerInstanceDisk>(join(instancesDir, name));
        if (
          disk === undefined ||
          typeof disk.server_id !== 'string' ||
          typeof disk.pid !== 'number' ||
          typeof disk.port !== 'number' ||
          !pidAlive(disk.pid)
        ) {
          return;
        }
        live.push({
          started_at: typeof disk.started_at === 'number' ? disk.started_at : 0,
          info: {
            id: disk.server_id,
            url: toUrl(disk.host, disk.port),
            pid: disk.pid,
            startedAt: typeof disk.started_at === 'number' ? disk.started_at : undefined,
            hostVersion: typeof disk.host_version === 'string' ? disk.host_version : undefined,
            source: 'instance',
          },
        });
      }),
  );
  live.sort((a, b) => a.started_at - b.started_at);
  return live.map((entry) => entry.info);
}

export async function readLiveLock(homeDir: string): Promise<DiscoveredServerInfo | undefined> {
  const disk = await readJson<ServerLockDisk>(join(homeDir, 'server', 'lock'));
  if (disk === undefined || typeof disk.pid !== 'number' || typeof disk.port !== 'number') {
    return undefined;
  }
  if (!pidAlive(disk.pid)) return undefined;
  return {
    id: 'lock',
    url: toUrl(disk.host, disk.port),
    pid: disk.pid,
    startedAt: typeof disk.started_at === 'number' ? disk.started_at : undefined,
    hostVersion: typeof disk.host_version === 'string' ? disk.host_version : undefined,
    source: 'lock',
  };
}

export async function readServerToken(homeDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  readonly proxyTarget?: string;
  readonly homeDir?: string;
}

export async function discoverLocalServers(
  options: DiscoverOptions = {},
): Promise<ServerDiscoveryPayload> {
  const home = options.homeDir ?? resolveKimiHomeDir();
  const [instances, lock, token] = await Promise.all([
    readLiveInstances(home),
    readLiveLock(home),
    readServerToken(home),
  ]);
  const byUrl = new Map<string, DiscoveredServerInfo>();
  for (const info of instances) byUrl.set(info.url, info);
  if (lock !== undefined && !byUrl.has(lock.url)) byUrl.set(lock.url, lock);
  const proxyUrl = options.proxyTarget?.replace(/\/$/, '');
  if (proxyUrl !== undefined && proxyUrl !== '' && !byUrl.has(proxyUrl)) {
    byUrl.set(proxyUrl, { id: 'proxy', url: proxyUrl, source: 'proxy' });
  }
  return { home, token, servers: [...byUrl.values()] };
}

export function serverDiscoveryPlugin(options: { proxyTarget: string }): Plugin {
  const handler = (_req: unknown, res: { setHeader(name: string, value: string): void; end(data: string): void }): void => {
    void discoverLocalServers({ proxyTarget: options.proxyTarget })
      .then((payload) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      })
      .catch((error: unknown) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(error), servers: [] }));
      });
  };
  return {
    name: 'kimi-inspect-server-discovery',
    configureServer(server) {
      server.middlewares.use(SERVER_DISCOVERY_ENDPOINT, handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(SERVER_DISCOVERY_ENDPOINT, handler);
    },
  };
}
