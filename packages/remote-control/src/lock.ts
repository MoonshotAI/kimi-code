import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  currentProcessLiveness,
  processStampAlive,
} from '@moonshot-ai/agent-core-v2/_base/utils/processLiveness';

export interface RemoteControlLockInfo {
  readonly pid: number;
  readonly nonce: string;
  readonly localOrigin: string;
  readonly deviceId: string;
  readonly url: string;
  readonly startedAt: number;
  readonly liveness?: string;
}

interface LockFileContent {
  readonly raw: string;
  readonly info?: RemoteControlLockInfo;
}

interface RemoteControlLockDisk {
  readonly pid: number;
  readonly nonce: string;
  readonly local_origin: string;
  readonly device_id: string;
  readonly url: string;
  readonly started_at: number;
  readonly liveness?: string;
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

export const REMOTE_CONTROL_LOGOUT_GATE_ORIGIN = 'logout in progress';

export interface RemoteControlLock {
  release(): Promise<void>;
}

const MAX_ACQUIRE_ATTEMPTS = 3;

const reclaimsInProgress = new Set<string>();

export async function acquireRemoteControlLock(
  homeDir: string,
  details: { localOrigin: string; deviceId: string; url: string },
): Promise<RemoteControlLock> {
  const lockPath = remoteControlLockPath(homeDir);
  await mkdir(dirname(lockPath), { recursive: true });
  const liveness = currentProcessLiveness();
  const info: RemoteControlLockInfo = {
    pid: process.pid,
    nonce: randomBytes(8).toString('hex'),
    localOrigin: details.localOrigin,
    deviceId: details.deviceId,
    url: details.url,
    startedAt: Date.now(),
    ...(liveness === undefined ? {} : { liveness }),
  };
  const record = encodeLock(info);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await publishLockRecord(lockPath, record, info.nonce);
      await removeReclaimMarkers(lockPath);
      return { release: () => releaseRemoteControlLock(lockPath, info.nonce) };
    } catch (error) {
      if (!alreadyExists(error) || attempt >= MAX_ACQUIRE_ATTEMPTS) {
        throw error;
      }
      const current = await readLockFile(lockPath);
      if (current === undefined) continue;
      if (current.info !== undefined && holderAlive(current.info)) {
        throw new RemoteControlAlreadyRunningError(current.info);
      }
      await reclaimStaleLock(lockPath, current.raw, record, info.nonce);
    }
  }
}

export async function inspectRemoteControlLock(
  homeDir: string,
): Promise<RemoteControlLockInfo | undefined> {
  const info = await readRemoteControlLock(remoteControlLockPath(homeDir));
  if (info === undefined || !holderAlive(info)) return undefined;
  return info;
}

export async function releaseRemoteControlLockHeldBy(
  homeDir: string,
  pid: number,
): Promise<boolean> {
  const lockPath = remoteControlLockPath(homeDir);
  const info = await readRemoteControlLock(lockPath);
  if (info === undefined || info.pid !== pid) return false;
  await removeFile(lockPath);
  return true;
}

async function publishLockRecord(path: string, record: string, nonce: string): Promise<void> {
  const staged = `${path}.${nonce}.tmp`;
  try {
    await writeFile(staged, record);
    try {
      await link(staged, path);
    } catch (error) {
      if (alreadyExists(error)) throw error;
      await writeLockRecordInPlace(path, record);
    }
  } finally {
    await unlink(staged).catch(() => {});
  }
}

async function writeLockRecordInPlace(path: string, record: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(record);
  } finally {
    await handle.close();
  }
}

async function reclaimStaleLock(
  lockPath: string,
  staleRaw: string,
  record: string,
  nonce: string,
): Promise<void> {
  reclaimsInProgress.add(nonce);
  try {
    const markerPath = await claimReclaimMarker(
      `${lockPath}.reclaim.${generationOf(staleRaw)}`,
      record,
      nonce,
    );
    if ((await readLockFile(lockPath))?.raw === staleRaw) await removeFile(lockPath);
    await releaseRemoteControlLock(markerPath, nonce).catch(() => {});
  } finally {
    reclaimsInProgress.delete(nonce);
  }
}

async function claimReclaimMarker(firstPath: string, record: string, nonce: string): Promise<string> {
  let markerPath = firstPath;
  for (;;) {
    try {
      await publishLockRecord(markerPath, record, nonce);
      return markerPath;
    } catch (error) {
      if (!alreadyExists(error)) throw error;
    }
    const owner = await readLockFile(markerPath);
    if (owner === undefined) continue;
    if (owner.info !== undefined && reclaimerActive(owner.info)) {
      throw new RemoteControlAlreadyRunningError(owner.info);
    }
    markerPath = `${markerPath}.${generationOf(owner.raw)}`;
  }
}

async function removeReclaimMarkers(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reclaim.`;
  const names = await readdir(directory).catch((): string[] => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && !name.endsWith('.tmp'))
      .map((name) => unlink(join(directory, name)).catch(() => {})),
  );
}

function reclaimerActive(owner: RemoteControlLockInfo): boolean {
  if (owner.pid === process.pid) return reclaimsInProgress.has(owner.nonce);
  return holderAlive(owner);
}

function generationOf(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

async function releaseRemoteControlLock(lockPath: string, nonce: string): Promise<void> {
  const info = await readRemoteControlLock(lockPath);
  if (info === undefined || info.nonce !== nonce) return;
  await removeFile(lockPath);
}

async function readRemoteControlLock(lockPath: string): Promise<RemoteControlLockInfo | undefined> {
  const content = await readLockFile(lockPath).catch(() => undefined);
  return content?.info;
}

async function readLockFile(path: string): Promise<LockFileContent | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const info = decodeLock(raw);
  return info === undefined ? { raw } : { raw, info };
}

function encodeLock(info: RemoteControlLockInfo): string {
  const disk: RemoteControlLockDisk = {
    pid: info.pid,
    nonce: info.nonce,
    local_origin: info.localOrigin,
    device_id: info.deviceId,
    url: info.url,
    started_at: info.startedAt,
    ...(info.liveness === undefined ? {} : { liveness: info.liveness }),
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
        ...(typeof parsed.liveness === 'string' && parsed.liveness.length > 0
          ? { liveness: parsed.liveness }
          : {}),
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

function holderAlive(holder: RemoteControlLockInfo): boolean {
  return processStampAlive({
    pid: holder.pid,
    startedAt: holder.startedAt,
    ...(holder.liveness === undefined ? {} : { liveness: holder.liveness }),
  });
}
