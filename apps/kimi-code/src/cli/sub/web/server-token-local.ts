/**
 * Local server token + instance-registry helpers — ported from kap-server
 * `services/auth/persistentToken.ts` + `instanceRegistry.ts` (G-2 web cutover:
 * the kap-server dependency is retired, `kimi web rotate-token` still needs
 * the token write and the live-instance discovery).
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** On-disk filename for the persistent token, relative to KIMI_CODE_HOME. */
export const SERVER_TOKEN_FILE = 'server.token';

/** Absolute path of the persistent token file for a given home dir. */
export function serverTokenPath(homeDir: string): string {
  return join(homeDir, SERVER_TOKEN_FILE);
}

/** Fresh 256-bit token, base64url-encoded (43 chars, URL-safe). */
export function generateServerToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Atomically write `token` to `<homeDir>/server.token` (0600). */
export async function writeServerToken(homeDir: string, token: string): Promise<void> {
  const filePath = serverTokenPath(homeDir);
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tmp, token, { mode: 0o600 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Generate and persist a brand-new token, invalidating the previous one.
 * A running server picks the new token up on its next auth check (the token
 * store re-reads the file when its mtime changes), so rotation takes effect
 * immediately without a restart.
 */
export async function rotateServerToken(homeDir: string): Promise<string> {
  const token = generateServerToken();
  await writeServerToken(homeDir, token);
  return token;
}

/** Resolve the Kimi home directory: `KIMI_CODE_HOME` env or `<osHome>/.kimi-code`. */
export function resolveKimiHome(homeDir?: string): string {
  if (homeDir !== undefined) return homeDir;
  return process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

/** In-memory shape of a registered instance (camelCase for TS consumers). */
export interface ServerInstanceInfo {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly hostVersion?: string;
}

/** On-disk JSON shape (snake_case, kap-server parity). */
interface ServerInstanceDisk {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  started_at: number;
  heartbeat_at: number;
  host_version?: string;
}

/** `process.kill(pid, 0)` probe — true if the pid exists, false on ESRCH. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM = process exists but we can't signal it (different user). Treat as alive.
    if (code === 'EPERM') return true;
    // Anything else: be safe, assume alive so we don't clobber a live entry.
    return true;
  }
}

function decodeInstance(raw: string): ServerInstanceInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerInstanceDisk>;
    if (
      typeof parsed.server_id === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.started_at === 'number' &&
      typeof parsed.heartbeat_at === 'number'
    ) {
      return {
        serverId: parsed.server_id,
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        startedAt: parsed.started_at,
        heartbeatAt: parsed.heartbeat_at,
        ...(parsed.host_version !== undefined ? { hostVersion: parsed.host_version } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every live instance in `<home>/server/instances`, lazily dropping
 * dead-pid entries. Results are sorted by `startedAt` ascending so "first" is
 * the longest-running instance — deterministic for consumers that pick one.
 */
export async function listLiveServerInstances(
  homeDir?: string,
): Promise<readonly ServerInstanceInfo[]> {
  const instancesDir = join(resolveKimiHome(homeDir), 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch {
    return [];
  }
  const live: ServerInstanceInfo[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const filePath = join(instancesDir, name);
        let raw: string;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          return;
        }
        const info = decodeInstance(raw);
        if (info === undefined || !pidAlive(info.pid)) return;
        live.push(info);
      }),
  );
  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

/**
 * Return the longest-running live instance, or `undefined` when none exist.
 * For callers that only need a single server to talk to (e.g. `kimi web
 * rotate-token` re-printing the access links).
 */
export async function getLiveServerInstance(
  homeDir?: string,
): Promise<ServerInstanceInfo | undefined> {
  const live = await listLiveServerInstances(homeDir);
  return live[0];
}
