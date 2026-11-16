import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface FileLockOptions {
  readonly acquireTimeoutMs: number;
  readonly retryIntervalMs: number;
  readonly staleMs: number;
  readonly label: string;
}

interface ParsedLockMeta {
  readonly pid: number;
  readonly sinceMs: number;
  readonly token?: string;
}

const inProcessLockChains = new Map<string, Promise<void>>();
const REAP_GUARD_TIMEOUT_MS = 2_000;
const REAP_GUARD_RETRY_MS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function parseLockMeta(content: string): ParsedLockMeta {
  const pid = Number(/pid=(\d+)/.exec(content)?.[1]);
  const sinceMs = Date.parse(/since=(\S+)/.exec(content)?.[1] ?? '');
  const token = /token=([^\s]+)/.exec(content)?.[1];
  return { pid, sinceMs, token };
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function isLockStale(path: string, content: string, staleMs: number): Promise<boolean> {
  const { pid, sinceMs } = parseLockMeta(content);
  const dead = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && pidIsDead(pid);
  if (dead) return true;
  if (Number.isFinite(sinceMs)) {
    return Date.now() - sinceMs > staleMs;
  }
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return false;
  return Date.now() - info.mtimeMs > staleMs;
}

async function createExclusiveLockFile(lockPath: string, payload: string): Promise<void> {
  const dir = dirname(lockPath);
  await mkdir(dir, { recursive: true });
  const staging = `${lockPath}.claim-${String(process.pid)}-${randomUUID()}`;
  await writeFile(staging, payload, 'utf8');
  try {
    await link(staging, lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      return;
    }
    throw error;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
}

async function acquireGuard(guardPath: string, staleMs: number): Promise<string | undefined> {
  const token = randomUUID();
  const deadline = Date.now() + REAP_GUARD_TIMEOUT_MS;
  for (;;) {
    try {
      const payload = `pid=${String(process.pid)} since=${new Date().toISOString()} token=${token}`;
      await createExclusiveLockFile(guardPath, payload);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const content = await readFile(guardPath, 'utf8').catch(() => undefined);
      if (content !== undefined && (await isLockStale(guardPath, content, staleMs))) {
        const expectedToken = parseLockMeta(content).token;
        const confirmed = await readFile(guardPath, 'utf8').catch(() => undefined);
        if (confirmed === content && parseLockMeta(confirmed).token === expectedToken) {
          await rm(guardPath, { force: true }).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) return undefined;
      await delay(REAP_GUARD_RETRY_MS);
    }
  }
}

async function releaseGuard(guardPath: string, token: string): Promise<void> {
  const content = await readFile(guardPath, 'utf8').catch(() => undefined);
  if (content === undefined) return;
  if (parseLockMeta(content).token !== token) return;
  await rm(guardPath, { force: true }).catch(() => undefined);
}

export async function reapStaleFileLock(lockPath: string, staleMs: number): Promise<boolean> {
  const guardPath = `${lockPath}.reap`;
  const guardToken = await acquireGuard(guardPath, staleMs);
  if (guardToken === undefined) return false;
  try {
    const content = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (content === undefined) return false;
    if (!(await isLockStale(lockPath, content, staleMs))) return false;
    const expectedToken = parseLockMeta(content).token;
    const confirmed = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (confirmed === undefined || confirmed !== content) return false;
    if (parseLockMeta(confirmed).token !== expectedToken) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await releaseGuard(guardPath, guardToken);
  }
}

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + options.acquireTimeoutMs;
  for (;;) {
    try {
      const payload = `pid=${String(process.pid)} since=${new Date().toISOString()} token=${token}`;
      await createExclusiveLockFile(lockPath, payload);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await reapStaleFileLock(lockPath, options.staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring ${options.label} lock at ${lockPath}`, {
          cause: error,
        });
      }
      await delay(options.retryIntervalMs);
    }
  }
}

export async function releaseFileLock(
  lockPath: string,
  token: string,
  staleMs: number,
): Promise<void> {
  const guardPath = `${lockPath}.reap`;
  const guardToken = await acquireGuard(guardPath, staleMs);
  try {
    const content = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (content === undefined) return;
    if (parseLockMeta(content).token !== token) return;
    await rm(lockPath, { force: true });
  } finally {
    if (guardToken !== undefined) {
      await releaseGuard(guardPath, guardToken);
    }
  }
}

export function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(lockPath);
  const previous = inProcessLockChains.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const token = await acquireFileLock(lockPath, options);
    try {
      return await fn();
    } finally {
      await releaseFileLock(lockPath, token, options.staleMs);
    }
  });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  inProcessLockChains.set(key, tail);
  void tail.finally(() => {
    if (inProcessLockChains.get(key) === tail) {
      inProcessLockChains.delete(key);
    }
  });
  return run;
}
