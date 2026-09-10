import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LockFile } from './lockfile.js';
import { withWindowsEpermRetry } from './rename-replace.js';

export type WipeOutcome = 'wiped' | 'locked';

export interface WipeStoreDirOptions {
  readonly dir: string;
  readonly lockAcquireTimeoutMs?: number;
  readonly lockFiles?: readonly string[];
}

async function acquireWithWait(lock: LockFile, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    if (await lock.acquire()) return true;
    if (Date.now() + delay > deadline) return false;
    const wait = delay + Math.floor(Math.random() * delay);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
    delay = Math.min(delay * 2, 250);
  }
}

export async function wipeStoreDir(opts: WipeStoreDirOptions): Promise<WipeOutcome> {
  const lockFiles = opts.lockFiles ?? ['db.lock'];
  const timeoutMs = opts.lockAcquireTimeoutMs ?? 0;
  const locks = lockFiles.map((file) => new LockFile(path.join(opts.dir, file)));
  const releaseAll = (): Promise<unknown[]> =>
    Promise.all(locks.map((lock) => lock.release().catch(() => {})));
  const results = await Promise.allSettled(locks.map((lock) => acquireWithWait(lock, timeoutMs)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed !== undefined || results.some((r) => r.status === 'fulfilled' && !r.value)) {
    await releaseAll();
    if (failed !== undefined) throw failed.reason;
    return 'locked';
  }
  try {
    const isolated = `${opts.dir}.wiping-${process.pid}-${randomUUID()}`;
    try {
      await withWindowsEpermRetry(() => fs.rename(opts.dir, isolated));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'wiped';
      throw error;
    }
    await fs.rm(isolated, { recursive: true, force: true });
  } finally {
    await releaseAll();
  }
  return 'wiped';
}
