/**
 * `crossProcessLock` domain — node-local kernel-lock integration tests.
 *
 * Exercises permanent sentinels, diagnostic owner metadata, fail-fast and
 * waiting acquisition, and release behavior against a real temporary
 * directory.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import {
  CrossProcessLockErrorCode,
  type CrossProcessLockServiceDeps,
  type ICrossProcessLockHandle,
} from '#/os/interface/crossProcessLock';

let tmpDir: string;
let lockPath: string;
const handles: ICrossProcessLockHandle[] = [];

function service(
  instanceId: string,
  pid: number,
  deps: Pick<CrossProcessLockServiceDeps, 'now' | 'sleep'> = {},
): CrossProcessLockService {
  let sequence = 0;
  return new CrossProcessLockService({
    ...deps,
    instanceId,
    selfPid: pid,
    newLockId: () => `${instanceId}-${++sequence}`,
  });
}

function ownerPath(): string {
  return `${lockPath}.owner.json`;
}

function readOwner(): Record<string, unknown> {
  return JSON.parse(readFileSync(ownerPath(), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-kernel-lock-'));
  lockPath = join(tmpDir, 'resource.lock');
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CrossProcessLockService', () => {
  it('keeps a permanent sentinel and treats owner metadata as diagnostic state', async () => {
    const lock = service('alpha', 1001);
    expect(lock.inspect(lockPath)).toEqual({ state: 'free' });
    expect(existsSync(lockPath)).toBe(true);

    const handle = await lock.acquire(lockPath, {
      address: 'http://127.0.0.1:58627',
    });
    handles.push(handle);

    expect(lock.inspect(lockPath)).toEqual({
      state: 'held',
      payload: {
        lockId: 'alpha-1',
        instanceId: 'alpha',
        pid: 1001,
        address: 'http://127.0.0.1:58627',
      },
    });
    expect(readOwner()).toEqual({
      lock_id: 'alpha-1',
      instance_id: 'alpha',
      pid: 1001,
      address: 'http://127.0.0.1:58627',
    });

    handle.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(ownerPath())).toBe(false);
    expect(lock.inspect(lockPath)).toEqual({ state: 'free' });
  });

  it('rejects a second holder in the same process', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);

    await expect(service('beta', 2002).acquire(lockPath)).rejects.toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { path: lockPath, reason: 'held' },
    });
  });

  it('reports creating when a holder has no readable owner metadata', async () => {
    const lock = service('alpha', 1001);
    const handle = await lock.acquire(lockPath);
    handles.push(handle);
    writeFileSync(ownerPath(), '{');

    expect(lock.inspect(lockPath)).toEqual({ state: 'creating' });
  });

  it('waits until the holder releases', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);
    setTimeout(() => first.release(), 20);

    const second = await service('beta', 2002).acquireWithWait(lockPath, {
      wait: { timeoutMs: 500, retryIntervalMs: 5 },
    });
    handles.push(second);
    expect(second.checkHeld()).toBe(true);
  });

  it('times out waiting for a held lock', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);

    await expect(
      service('beta', 2002).acquireWithWait(lockPath, {
        wait: { timeoutMs: 15, retryIntervalMs: 5 },
      }),
    ).rejects.toMatchObject({ code: CrossProcessLockErrorCode.WaitTimeout });
  });

  it('releases a lock acquired as the wait deadline expires', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);
    const times = [0, 0, 9, 10];
    const sleepDurations: number[] = [];
    const waiter = service('beta', 2002, {
      now: () => times.shift() ?? 10,
      sleep: async (ms) => {
        sleepDurations.push(ms);
        first.release();
      },
    });

    const result = await waiter
      .acquireWithWait(lockPath, { wait: { timeoutMs: 10, retryIntervalMs: 100 } })
      .then(
        (handle) => ({ status: 'acquired' as const, handle }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

    if (result.status === 'acquired') handles.push(result.handle);
    expect(sleepDurations).toEqual([10]);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toMatchObject({ code: CrossProcessLockErrorCode.WaitTimeout });
    }
    expect(waiter.inspect(lockPath)).toEqual({ state: 'free' });
  });

  it('withLock releases after the callback throws', async () => {
    const lock = service('alpha', 1001);
    await expect(
      lock.withLock(lockPath, { wait: { timeoutMs: 100 } }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const next = await service('beta', 2002).acquire(lockPath);
    handles.push(next);
    expect(next.checkHeld()).toBe(true);
  });

  it('release is idempotent and checkHeld fails closed afterwards', async () => {
    const handle = await service('alpha', 1001).acquire(lockPath);
    handle.release();
    handle.release();

    expect(handle.checkHeld()).toBe(false);
  });
});
