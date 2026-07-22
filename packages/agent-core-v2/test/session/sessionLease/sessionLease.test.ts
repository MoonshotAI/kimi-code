/**
 * `sessionLease` domain — unit tests for the per-session write lease.
 *
 * Runs against the real node-local kernel-lock service rooted at a mkdtemp
 * home, asserting loss notification, write admission/draining, and release.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import { SessionLease, sessionLeasePath } from '#/session/sessionLease/sessionLease';

let tmpDir: string;
let locks: CrossProcessLockService;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-session-lease-'));
  locks = new CrossProcessLockService();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function acquire(
  sessionId = 's1',
  onLost: (sessionId: string) => void = () => {},
): Promise<SessionLease> {
  return new SessionLease(
    sessionId,
    await locks.acquire(sessionLeasePath(tmpDir, sessionId)),
    onLost,
  );
}

function thrownError(fn: () => void): Error2 {
  try {
    fn();
  } catch (error) {
    return error as Error2;
  }
  throw new Error('expected the call to throw');
}

describe('SessionLease', () => {
  it('fires the loss notification once and then fails closed', async () => {
    const onLost = vi.fn();
    const lease = await acquire('s1', onLost);
    // Replacing the sentinel fails the kernel handle's dev/ino identity
    // check, driving the loss path through the real gate.
    rmSync(sessionLeasePath(tmpDir, 's1'));
    writeFileSync(sessionLeasePath(tmpDir, 's1'), '');
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('s1');
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent and later assertions throw', async () => {
    const lease = await acquire();
    lease.release();
    lease.release();

    expect(lease.info).toBeUndefined();
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
  });

  it('sealAndDrain rejects new writes while waiting for an admitted physical write', async () => {
    const lease = await acquire();
    let enterWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    let finishWrite!: () => void;
    const physicalWriteBlocked = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const write = lease.withPhysicalWrite(async () => {
      enterWrite();
      await physicalWriteBlocked;
    });
    await writeEntered;

    let drained = false;
    const drain = lease.sealAndDrain().then(() => {
      drained = true;
    });
    await expect(lease.withPhysicalWrite(async () => {})).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LEASE_LOST,
    });
    expect(drained).toBe(false);

    finishWrite();
    await write;
    await drain;
    expect(drained).toBe(true);
    lease.release();
  });
});
