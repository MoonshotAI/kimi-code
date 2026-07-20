/**
 * `sessionLease` domain — unit tests for the per-session write lease.
 *
 * Runs against the real node-local cross-process lock service (pid-only
 * handles: no heartbeat timers) rooted at a mkdtemp home, asserting on-disk
 * lease payload contents, the once-only loss notification, the idempotent
 * token-guarded release, and the contact-provider seed semantics (default
 * local, seed override wins — the exact production wiring).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  HOLDER_UNRESPONSIVE_RETRY_AFTER_MS,
  LEASE_CREATING_RETRY_AFTER_MS,
  SessionLease,
  sessionLeasePath,
  SESSION_LEASE_HEARTBEAT_INTERVAL_MS,
  SESSION_LEASE_TTL_MS,
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
    expect(lease.checkHeld()).toBe(true);
    expect(lease.info).toEqual({ sessionId: 's1', lockId: lease.lockId });
    expect(() => lease.assertWritable()).not.toThrow();
    lease.release();
  });

  it('fails closed with session.lease_lost once the payload no longer carries its token', async () => {
    const onLost = vi.fn();
    const lease = await acquire('s1', onLost);
    writeFileSync(
      sessionLeasePath(tmpDir, 's1'),
      JSON.stringify({ lock_id: 'peer-token', pid: process.pid }),
    );

    expect(lease.checkHeld()).toBe(false);
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
    // Loss fires exactly once across every detection path.
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('s1');
    lease.markLost();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent, unlinks the owned file, and later assertions throw', async () => {
    const lease = await acquire();
    lease.release();
    lease.release();

    expect(lease.released).toBe(true);
    expect(lease.info).toBeUndefined();
    expect(existsSync(sessionLeasePath(tmpDir, 's1'))).toBe(false);
    expect(thrownError(() => lease.assertWritable()).code).toBe(ErrorCodes.SESSION_LEASE_LOST);
  });

  it('release never unlinks a payload owned by a peer', async () => {
    const lease = await acquire();
    writeFileSync(
      sessionLeasePath(tmpDir, 's1'),
      JSON.stringify({ lock_id: 'peer-token', pid: process.pid }),
    );
    lease.release();

    expect(lease.released).toBe(true);
    const payload = JSON.parse(readFileSync(sessionLeasePath(tmpDir, 's1'), 'utf8'));
    expect(payload.lock_id).toBe('peer-token');
  });

  it('exported constants pin the documented protocol timings', () => {
    expect(SESSION_LEASE_HEARTBEAT_INTERVAL_MS).toBe(2000);
    expect(SESSION_LEASE_TTL_MS).toBe(6000);
    expect(LEASE_CREATING_RETRY_AFTER_MS).toBe(1000);
    expect(HOLDER_UNRESPONSIVE_RETRY_AFTER_MS).toBe(2000);
  });

  it('sessionLeasePath lives under <home>/session-leases/', () => {
    expect(sessionLeasePath('/home/kimi', 'abc')).toBe(
      join('/home/kimi', 'session-leases', 'abc.json'),
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
