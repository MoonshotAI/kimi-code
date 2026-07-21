/**
 * `sessionLease` domain — unit tests for the per-session write lease.
 *
 * Runs against the real node-local kernel-lock service rooted at a mkdtemp
 * home, asserting permanent sentinel behavior, the once-only loss
 * notification, idempotent release, and contact-provider seed semantics.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopedTestHost, type ScopedTestHost } from '#/_base/di/test';
import { Error2, ErrorCodes } from '#/errors';
import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import {
  ISessionLeaseContactProvider,
  sessionLeaseContactSeed,
} from '#/session/sessionLease/sessionLeaseContactProvider';
import {
  LEASE_CREATING_RETRY_AFTER_MS,
  SessionLease,
  sessionLeasePath,
} from '#/session/sessionLease/sessionLease';

let tmpDir: string;
let locks: CrossProcessLockService;
const hosts: ScopedTestHost[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-session-lease-'));
  locks = new CrossProcessLockService();
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
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

function hostWith(seeds: Parameters<typeof createScopedTestHost>[0] = []): ScopedTestHost {
  const host = createScopedTestHost(seeds);
  hosts.push(host);
  return host;
}

describe('SessionLease', () => {
  it('reports its identity through info and passes the hard gate while held', async () => {
    const lease = await acquire();
    expect(lease.info).toEqual({ sessionId: 's1', lockId: lease.lockId });
    expect(() => lease.assertWritable()).not.toThrow();
    lease.release();
  });

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

  it('release is idempotent, keeps the sentinel, and later assertions throw', async () => {
    const lease = await acquire();
    lease.release();
    lease.release();

    expect(lease.info).toBeUndefined();
    expect(existsSync(sessionLeasePath(tmpDir, 's1'))).toBe(true);
    expect(existsSync(`${sessionLeasePath(tmpDir, 's1')}.owner.json`)).toBe(false);
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
  });

  it('exports only the retry delay for an owner metadata creation window', () => {
    expect(LEASE_CREATING_RETRY_AFTER_MS).toBe(1000);
  });

  it('sessionLeasePath lives under <home>/session-leases/', () => {
    expect(sessionLeasePath('/home/kimi', 'abc')).toBe(
      join('/home/kimi', 'session-leases', 'abc.lock'),
    );
  });
});

describe('session lease contact provider', () => {
  it('resolves a local contact by default when the host seeds nothing', () => {
    const host = hostWith();
    expect(host.app.accessor.get(ISessionLeaseContactProvider).contact()).toEqual({
      type: 'local',
    });
  });

  it('the seed overrides the registered default with the host address', () => {
    const host = hostWith(
      sessionLeaseContactSeed(() => ({ type: 'address', address: 'http://127.0.0.1:8080' })),
    );
    expect(host.app.accessor.get(ISessionLeaseContactProvider).contact()).toEqual({
      type: 'address',
      address: 'http://127.0.0.1:8080',
    });
  });

  it('evaluates the contact lazily at every lease acquisition', () => {
    let contact: { type: 'address'; address: string } | { type: 'local' } = { type: 'local' };
    const host = hostWith(sessionLeaseContactSeed(() => contact));
    const provider = host.app.accessor.get(ISessionLeaseContactProvider);
    contact = { type: 'address', address: 'http://127.0.0.1:9999' };
    expect(provider.contact()).toEqual({ type: 'address', address: 'http://127.0.0.1:9999' });
  });
});
