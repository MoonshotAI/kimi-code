import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';

export const HEARTBEAT_INTERVAL_MS = 15_000;

export const DEFAULT_SERVER_DIR = join(resolveKimiHome(), 'server');
export const DEFAULT_SERVER_INSTANCES_DIR = join(DEFAULT_SERVER_DIR, 'instances');

export interface ServerInstanceInfo {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly serverVersion?: string;
}

interface ServerInstanceDisk {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  started_at: number;
  heartbeat_at: number;
  host_version?: string;
}

export interface InstanceRegistration {
  readonly serverId: string;
  update(patch: { port?: number }): Promise<void>;
  release(): Promise<void>;
}

export interface IInstanceRegistry {
  register(
    info: Omit<ServerInstanceInfo, 'serverId' | 'heartbeatAt'>,
  ): Promise<InstanceRegistration>;
  listLive(): Promise<readonly ServerInstanceInfo[]>;
}

export interface InstanceRegistryOptions {
  readonly instancesDir?: string;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return true;
  }
}

function isInstanceFile(name: string): boolean {
  return name.endsWith('.json');
}

function encode(info: ServerInstanceInfo): string {
  const disk: ServerInstanceDisk = {
    server_id: info.serverId,
    pid: info.pid,
    host: info.host,
    port: info.port,
    started_at: info.startedAt,
    heartbeat_at: info.heartbeatAt,
    ...(info.serverVersion !== undefined ? { host_version: info.serverVersion } : {}),
  };
  return JSON.stringify(disk);
}

function decode(raw: string): ServerInstanceInfo | undefined {
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
        ...(parsed.host_version !== undefined ? { serverVersion: parsed.host_version } : {}),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readInstanceFile(filePath: string): Promise<ServerInstanceInfo | undefined> {
  try {
    return decode(await readFile(filePath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

async function sweepStale(instancesDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(
    names.filter(isInstanceFile).map(async (name) => {
      const filePath = join(instancesDir, name);
      const info = await readInstanceFile(filePath);
      if (info === undefined || pidAlive(info.pid)) return;
      try {
        await unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }),
  );
}

async function listLiveInternal(instancesDir: string): Promise<readonly ServerInstanceInfo[]> {
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const live: ServerInstanceInfo[] = [];
  await Promise.all(
    names.filter(isInstanceFile).map(async (name) => {
      const filePath = join(instancesDir, name);
      const info = await readInstanceFile(filePath);
      if (info === undefined) return;
      if (!pidAlive(info.pid)) {
        try {
          await unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        return;
      }
      live.push(info);
    }),
  );
  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

export function createInstanceRegistry(options: InstanceRegistryOptions = {}): IInstanceRegistry {
  const instancesDir = options.instancesDir ?? DEFAULT_SERVER_INSTANCES_DIR;
  const now = options.now ?? Date.now;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

  return {
    async register(info) {
      const serverId = ulid();
      const filePath = join(instancesDir, `${serverId}.json`);
      await mkdir(instancesDir, { recursive: true });
      await sweepStale(instancesDir);

      const state: { port: number; released: boolean } = { port: info.port, released: false };

      let inflightWrites = 0;
      let onWritesDrained: (() => void) | null = null;

      const write = async (): Promise<void> => {
        if (state.released) return;
        inflightWrites += 1;
        try {
          const full: ServerInstanceInfo = {
            serverId,
            pid: info.pid,
            host: info.host,
            port: state.port,
            startedAt: info.startedAt,
            heartbeatAt: now(),
            ...(info.serverVersion !== undefined ? { serverVersion: info.serverVersion } : {}),
          };
          await writeFileAtomic(filePath, encode(full));
        } finally {
          inflightWrites -= 1;
          if (inflightWrites === 0) onWritesDrained?.();
        }
      };

      await write();

      const timer = setInterval(() => {
        void write().catch(() => {
        });
      }, heartbeatIntervalMs);
      timer.unref();

      return {
        serverId,
        async update(patch) {
          if (state.released) return;
          if (patch.port !== undefined) state.port = patch.port;
          await write();
        },
        async release() {
          if (state.released) return;
          state.released = true;
          clearInterval(timer);
          if (inflightWrites > 0) {
            await new Promise<void>((resolve) => {
              onWritesDrained = resolve;
            });
          }
          try {
            await unlink(filePath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        },
      };
    },

    listLive() {
      return listLiveInternal(instancesDir);
    },
  };
}

export function resolveServerInstancesDir(homeDir?: string): string {
  return homeDir === undefined
    ? DEFAULT_SERVER_INSTANCES_DIR
    : join(homeDir, 'server', 'instances');
}

export async function listLiveServerInstances(
  homeDir?: string,
): Promise<readonly ServerInstanceInfo[]> {
  return createInstanceRegistry({ instancesDir: resolveServerInstancesDir(homeDir) }).listLive();
}

export async function getLiveServerInstance(
  homeDir?: string,
): Promise<ServerInstanceInfo | undefined> {
  const live = await listLiveServerInstances(homeDir);
  return live[0];
}
