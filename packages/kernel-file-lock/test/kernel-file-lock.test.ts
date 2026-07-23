import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireKernelFileLock, type KernelFileLockHandle } from '../src/index.js';

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

  it('releases the lock when the holder process is killed without releasing', async () => {
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
    await withTimeout(ready, 5_000, 'holder did not become ready');
    expect(tryAcquireKernelFileLock(lockPath)).toBeUndefined();

    // No clean release: the kernel must drop the lock with the dead process.
    child.kill('SIGKILL');
    await withTimeout(exit, 5_000, 'holder did not exit after SIGKILL');
    const handle = tryAcquireKernelFileLock(lockPath);
    expect(handle).toBeDefined();
    handles.push(handle!);
  });
});
