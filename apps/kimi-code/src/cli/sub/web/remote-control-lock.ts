import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RemoteControlLockInfo {
  readonly pid: number;
  readonly nonce: string;
  readonly localOrigin: string;
  readonly deviceId: string;
  readonly url: string;
  readonly startedAt: number;
}

interface RemoteControlLockDisk {
  readonly pid: number;
  readonly nonce: string;
  readonly local_origin: string;
  readonly device_id: string;
  readonly url: string;
  readonly started_at: number;
}

export class RemoteControlAlreadyRunningError extends Error {
  readonly holder: RemoteControlLockInfo;

  constructor(holder: RemoteControlLockInfo) {
    super(formatRemoteControlAlreadyRunning(holder));
    this.name = 'RemoteControlAlreadyRunningError';
    this.holder = holder;
  }
}

export function formatRemoteControlAlreadyRunning(holder: RemoteControlLockInfo): string {
  return [
    `Remote Control is already running on this machine (pid ${holder.pid}, ${holder.localOrigin}, since ${new Date(holder.startedAt).toLocaleString()}).`,
    `Use the existing link: ${holder.url}`,
    'To start a new one here, stop the other `kimi web --remote-control` process first.',
  ].join('\n');
}

export function remoteControlLockPath(homeDir: string): string {
  return join(homeDir, 'server', 'rc.json');
}

export interface RemoteControlLock {
  release(): Promise<void>;
}

const MAX_ACQUIRE_ATTEMPTS = 3;

export async function acquireRemoteControlLock(
  homeDir: string,
  details: { localOrigin: string; deviceId: string; url: string },
): Promise<RemoteControlLock> {
  const lockPath = remoteControlLockPath(homeDir);
  await mkdir(dirname(lockPath), { recursive: true });
  const info: RemoteControlLockInfo = {
    pid: process.pid,
    nonce: randomBytes(8).toString('hex'),
    localOrigin: details.localOrigin,
    deviceId: details.deviceId,
    url: details.url,
    startedAt: Date.now(),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(encodeLock(info));
      } finally {
        await handle.close();
      }
      return { release: () => releaseRemoteControlLock(lockPath, info.nonce) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= MAX_ACQUIRE_ATTEMPTS) {
        throw error;
      }
      const holder = await readRemoteControlLock(lockPath);
      if (holder !== undefined && pidAlive(holder.pid)) {
        throw new RemoteControlAlreadyRunningError(holder);
      }
      await removeFile(lockPath);
    }
  }
}

export async function inspectRemoteControlLock(
  homeDir: string,
): Promise<RemoteControlLockInfo | undefined> {
  const lockPath = remoteControlLockPath(homeDir);
  const info = await readRemoteControlLock(lockPath);
  if (info === undefined) return undefined;
  if (!pidAlive(info.pid)) {
    await removeFile(lockPath);
    return undefined;
  }
  return info;
}

async function releaseRemoteControlLock(lockPath: string, nonce: string): Promise<void> {
  const info = await readRemoteControlLock(lockPath);
  if (info === undefined || info.nonce !== nonce) return;
  await removeFile(lockPath);
}

async function readRemoteControlLock(lockPath: string): Promise<RemoteControlLockInfo | undefined> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  return decodeLock(raw);
}

function encodeLock(info: RemoteControlLockInfo): string {
  const disk: RemoteControlLockDisk = {
    pid: info.pid,
    nonce: info.nonce,
    local_origin: info.localOrigin,
    device_id: info.deviceId,
    url: info.url,
    started_at: info.startedAt,
  };
  return JSON.stringify(disk);
}

function decodeLock(raw: string): RemoteControlLockInfo | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteControlLockDisk>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.local_origin === 'string' &&
      typeof parsed.device_id === 'string' &&
      typeof parsed.url === 'string' &&
      typeof parsed.started_at === 'number'
    ) {
      return {
        pid: parsed.pid,
        nonce: parsed.nonce,
        localOrigin: parsed.local_origin,
        deviceId: parsed.device_id,
        url: parsed.url,
        startedAt: parsed.started_at,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function removeFile(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
