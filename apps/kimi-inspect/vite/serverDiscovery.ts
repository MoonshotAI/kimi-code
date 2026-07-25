/**
 * Local kap-server discovery — a dev/preview middleware that lets the browser
 * see and reach every kap-server running on this machine without typing a URL
 * or a token.
 *
 * kap-server already self-registers for peer discovery
 * (`packages/kap-server/src/instanceRegistry.ts`):
 *   current builds  `<kimi home>/server/instances/<serverId>.json`
 *   pre-registry builds  `<kimi home>/server/lock`
 * and persists the bearer token at `<kimi home>/server.token` (one token per
 * home, shared by every instance). The browser cannot read those files, but
 * this Vite process can, so `GET /__inspect/servers` answers with the live
 * instances (pid-liveness filtered), the dev-proxy target, and the token.
 *
 * The registry/lock file formats are deliberately reimplemented here (~100
 * lines) instead of importing kap-server: the inspector must stay free of
 * server-side dependencies.
 *
 * Security: dev/preview only, bound to loopback by Vite defaults. It hands
 * out the same token the user would otherwise paste from
 * `~/.kimi-code/server.token` by hand — no new exposure beyond the local dev
 * session.
 */

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

/** Mirror of the on-disk instance file (`server_id` …, snake_case). */
interface ServerInstanceDisk {
  server_id?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  host_version?: string;
}

/** Mirror of the legacy single-server lock written by pre-registry builds. */
interface ServerLockDisk {
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  host_version?: string;
}

/** home resolution per request: `KIMI_CODE_HOME` env, else `~/.kimi-code`. */
export function resolveKimiHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['KIMI_CODE_HOME'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.kimi-code');
}

/** `process.kill(pid, 0)` probe — same semantics as the server's registry:
 * ESRCH = dead, EPERM/anything else = alive (never clobber a live entry). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Browser-reachable host: wildcard binds advertise as loopback. */
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

/** Live instances under `<home>/server/instances`, sorted by `started_at`
 * ascending (longest-running first, matching the server's own ordering). */
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

/** The legacy single-server lock (`<home>/server/lock`) written by pre-registry
 * builds, when its pid is alive. Current builds never write it. */
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

/** The home-wide bearer token (`<home>/server.token`); undefined when absent/unreadable. */
export async function readServerToken(homeDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  /** The dev-proxy target (`KIMI_SERVER_URL`); merged as a `proxy` entry. */
  readonly proxyTarget?: string;
  /** home override; defaults to the request-time env resolution. */
  readonly homeDir?: string;
}

/** Assemble the full discovery payload: instances (oldest first) + lock +
 * proxy target, deduped by normalized URL, plus the home token. */
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

/** Vite plugin exposing `GET /__inspect/servers` on dev and preview servers. */
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
