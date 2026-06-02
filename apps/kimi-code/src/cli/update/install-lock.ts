import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getUpdateInstallLockFile } from '#/utils/paths';

const UPDATE_INSTALL_LOCK_STALE_MS = 30 * 60 * 1000;

export interface UpdateInstallLockRequest {
  readonly version: string;
  readonly now?: Date;
}

export interface UpdateInstallLockHandle {
  readonly filePath: string;
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

async function isStaleLock(filePath: string, now: Date): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return true;
    const lock = parsed as { readonly startedAt?: unknown };
    if (typeof lock.startedAt !== 'string') return true;
    const startedAt = Date.parse(lock.startedAt);
    if (!Number.isFinite(startedAt)) return true;
    return now.getTime() - startedAt > UPDATE_INSTALL_LOCK_STALE_MS;
  } catch (error) {
    if (isNotFound(error)) return true;
    if (error instanceof SyntaxError) return true;
    return false;
  }
}

async function createLockFile(
  filePath: string,
  request: UpdateInstallLockRequest,
): Promise<UpdateInstallLockHandle> {
  const now = request.now ?? new Date();
  const file = await open(filePath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({
      version: request.version,
      pid: process.pid,
      startedAt: now.toISOString(),
    }, null, 2)}\n`, 'utf-8');
  } finally {
    await file.close();
  }

  return {
    filePath,
    release: async (): Promise<void> => {
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

  if (!(await isStaleLock(filePath, request.now ?? new Date()))) return null;
  await unlink(filePath).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });

  try {
    return await createLockFile(filePath, request);
  } catch (error) {
    if (isAlreadyExists(error)) return null;
    throw error;
  }
}
