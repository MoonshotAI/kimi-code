import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireKernelFileLock,
  KernelFileLockTimeoutError,
  setKernelFileLockBindingLoader,
  tryAcquireKernelFileLock,
  type KernelFileLockBinding,
  type KernelFileLockHandle,
} from '../src/index.js';

let tmpDir: string;
let lockPath: string;
const handles: KernelFileLockHandle[] = [];

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kernel-file-lock-'));
  lockPath = join(tmpDir, 'resource.lock');
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  setKernelFileLockBindingLoader(undefined);
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('kernel-file-lock', () => {
  it('holds an exclusive lock and keeps the sentinel after release', () => {
    const first = tryAcquireKernelFileLock(lockPath);
    expect(first).toBeDefined();
    handles.push(first!);
    expect(tryAcquireKernelFileLock(lockPath)).toBeUndefined();

    first!.release();
    expect(existsSync(lockPath)).toBe(true);
    const second = tryAcquireKernelFileLock(lockPath);
    expect(second).toBeDefined();
    handles.push(second!);
  });

  it('waits and times out without taking ownership', async () => {
    const first = tryAcquireKernelFileLock(lockPath)!;
    handles.push(first);

    await expect(
      acquireKernelFileLock(lockPath, { timeoutMs: 15, retryIntervalMs: 5 }),
    ).rejects.toBeInstanceOf(KernelFileLockTimeoutError);
  });

  it('does not acquire a lock released after the deadline', async () => {
    const first = tryAcquireKernelFileLock(lockPath)!;
    handles.push(first);
    const releaseTimer = setTimeout(() => first.release(), 20);

    const result = await acquireKernelFileLock(lockPath, {
      timeoutMs: 10,
      retryIntervalMs: 100,
    }).then(
      (handle) => ({ status: 'acquired' as const, handle }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    clearTimeout(releaseTimer);

    if (result.status === 'acquired') handles.push(result.handle);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toBeInstanceOf(KernelFileLockTimeoutError);
    }
  });

  it('releases a lock acquired as a retry crosses the deadline', async () => {
    let lockCalls = 0;
    let unlockCalls = 0;
    const times = [0, 0, 9, 10];
    const nativeBinding: KernelFileLockBinding = {
      flockSync: (_fd, flags) => {
        if (flags === 'un') {
          unlockCalls++;
          return 0;
        }
        lockCalls++;
        if (lockCalls === 1) {
          throw Object.assign(new Error('busy'), { code: 'EAGAIN' });
        }
        return 0;
      },
    };
    setKernelFileLockBindingLoader(() => nativeBinding);
    vi.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 10);

    const result = await acquireKernelFileLock(lockPath, {
      timeoutMs: 10,
      retryIntervalMs: 0,
    }).then(
      (handle) => ({ status: 'acquired' as const, handle }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    if (result.status === 'acquired') handles.push(result.handle);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toBeInstanceOf(KernelFileLockTimeoutError);
    }
    expect(unlockCalls).toBe(1);
  });

  it('allows the immediate first attempt with a zero timeout', async () => {
    const handle = await acquireKernelFileLock(lockPath, { timeoutMs: 0 });
    handles.push(handle);

    expect(handle.checkHeld()).toBe(true);
  });

  it('coordinates with a separate process', async () => {
    const holderPath = fileURLToPath(new URL('./holder.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', holderPath, lockPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exit = once(child, 'exit');
    void exit.catch(() => {});
    const ready = Promise.race([
      once(child.stdout!, 'data'),
      exit.then(() => {
        throw new Error('holder exited before becoming ready');
      }),
    ]);
    try {
      await withTimeout(ready, 5_000, 'holder did not become ready');
      expect(tryAcquireKernelFileLock(lockPath)).toBeUndefined();

      child.stdin!.end('release\n');
      await withTimeout(exit, 5_000, 'holder did not exit after release');
      const handle = tryAcquireKernelFileLock(lockPath);
      expect(handle).toBeDefined();
      handles.push(handle!);
    } finally {
      child.stdin?.end();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill();
        try {
          await withTimeout(exit, 1_000, 'holder did not terminate');
        } catch {
          child.kill('SIGKILL');
          await withTimeout(exit, 1_000, 'holder did not terminate after SIGKILL');
        }
      }
    }
  });
});
