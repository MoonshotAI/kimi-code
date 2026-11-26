import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { processStampAlive } from '@moonshot-ai/agent-core-v2/_base/utils/processLiveness';

import { getUpdateInstallLockFile } from '#/utils/paths';
import { createFileIfAbsent } from '#/utils/persistence';

const UPDATE_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

const TAKEOVER_LOCK_STALE_MS = 60_000;

const LOCK_PUBLISH_GRACE_MS = 60_000;

export interface UpdateInstallLockRequest {
  readonly version: string;
  readonly now?: Date;
}

export interface UpdateInstallLockHandle {
  readonly filePath: string;
  readonly content: string;
  release(): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST'
  );
}

interface LockInspection {
  readonly content: string;
  readonly mtimeMs: number;
}

async function inspectLockFile(filePath: string): Promise<LockInspection | null> {
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (content === null) return null;
  const info = await stat(filePath).catch(() => null);
  if (info === null) return null;
  return { content, mtimeMs: info.mtimeMs };
}

function isStaleLock(inspection: LockInspection, now: Date): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.content);
  } catch {
    return now.getTime() - inspection.mtimeMs > LOCK_PUBLISH_GRACE_MS;
  }
  if (typeof parsed !== 'object' || parsed === null) return true;
  const lock = parsed as { readonly startedAt?: unknown; readonly pid?: unknown };
  if (typeof lock.startedAt !== 'string') return true;
  const startedAt = Date.parse(lock.startedAt);
  if (!Number.isFinite(startedAt)) return true;
  if (typeof lock.pid === 'number' && !processStampAlive({ pid: lock.pid, startedAt })) {
    return true;
  }
  if (now.getTime() - startedAt <= UPDATE_INSTALL_LOCK_STALE_MS) return false;
  return typeof lock.pid !== 'number';
}

async function createLockFile(
  filePath: string,
  request: UpdateInstallLockRequest,
): Promise<UpdateInstallLockHandle | null> {
  const now = request.now ?? new Date();
  const content = `${JSON.stringify({
    version: request.version,
    pid: process.pid,
    startedAt: now.toISOString(),
  }, null, 2)}\n`;
  await createFileIfAbsent(filePath, content);
  const published = await readFile(filePath, 'utf-8').catch(() => null);
  if (published !== content) return null;

  return {
    filePath,
    content,
    release: async (): Promise<void> => {
      const current = await readFile(filePath, 'utf-8').catch(() => null);
      if (current !== content) return;
      await unlink(filePath).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    },
  };
}

export async function tryAcquireUpdateInstallLock(
  request: UpdateInstallLockRequest,
  filePath: string = getUpdateInstallLockFile(),
): Promise<UpdateInstallLockHandle | null> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    return await createLockFile(filePath, request);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const inspected = await inspectLockFile(filePath);
  if (inspected !== null && !isStaleLock(inspected, request.now ?? new Date())) {
    return null;
  }
  if (inspected === null) {
    try {
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  }

  const takeoverPath = `${filePath}.takeover`;
  if (!(await acquireTakeoverLock(takeoverPath))) return null;
  try {
    const current = await inspectLockFile(filePath);
    if (current !== null && !isStaleLock(current, request.now ?? new Date())) {
      return null;
    }
    if (current !== null) {
      await unlink(filePath).catch(() => {});
    }
    try {
      return await createLockFile(filePath, request);
    } catch (error) {
      if (isAlreadyExists(error)) return null;
      throw error;
    }
  } finally {
    await unlink(takeoverPath).catch(() => {});
  }
}

async function acquireTakeoverLock(takeoverPath: string): Promise<boolean> {
  if (await publishTakeoverMarker(takeoverPath)) return true;
  const info = await stat(takeoverPath).catch(() => null);
  if (info !== null && Date.now() - info.mtimeMs <= TAKEOVER_LOCK_STALE_MS) return false;
  await unlink(takeoverPath).catch(() => {});
  return publishTakeoverMarker(takeoverPath);
}

async function publishTakeoverMarker(target: string): Promise<boolean> {
  const marker = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    await createFileIfAbsent(target, marker);
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
  const published = await readFile(target, 'utf-8').catch(() => null);
  return published === marker;
}

export async function readUpdateInstallLockVersion(
  filePath: string = getUpdateInstallLockFile(),
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}
