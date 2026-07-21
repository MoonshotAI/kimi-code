/**
 * `crossProcessLock` domain — node-local kernel-lock integration tests.
 *
 * Exercises permanent sentinels, diagnostic owner metadata, fail-fast and
 * waiting acquisition, and release behavior against a real temporary
 * directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-kernel-lock-'));
  lockPath = join(tmpDir, 'resource.lock');
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('CrossProcessLockService', () => {
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

  it('times out waiting for a held lock', async () => {
    const first = await service('alpha', 1001).acquire(lockPath);
    handles.push(first);

    await expect(
      service('beta', 2002).withLock(lockPath, { wait: { timeoutMs: 15, retryIntervalMs: 5 } }, () => {}),
    ).rejects.toMatchObject({ code: CrossProcessLockErrorCode.WaitTimeout });
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
