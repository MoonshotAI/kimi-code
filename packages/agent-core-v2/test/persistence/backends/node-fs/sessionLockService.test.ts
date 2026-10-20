import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { SessionLockHolder } from '#/persistence/interface/sessionLock';
import { SessionLockService } from '#/persistence/backends/node-fs/sessionLockService';
import { noopLogger } from '../../../wire/stubs';

const SID = 'session-1';

function bootstrapStub(homeDir: string, platform = 'test_client'): IBootstrapService {
  return {
    homeDir,
    clientIdentity: { productName: 'test', version: '0.0.0', platform },
  } as IBootstrapService;
}

function lockPath(homeDir: string, sessionId: string): string {
  return join(homeDir, 'locks', 'sessions', `${sessionId}.lock`);
}

function readLockFile(homeDir: string, sessionId: string): SessionLockHolder {
  return JSON.parse(readFileSync(lockPath(homeDir, sessionId), 'utf8')) as SessionLockHolder;
}

describe('SessionLockService', () => {
  let homeDir: string;
  let serviceA: SessionLockService;
  let serviceB: SessionLockService;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'session-lock-'));
    serviceA = new SessionLockService(bootstrapStub(homeDir, 'client_a'), noopLogger);
    serviceB = new SessionLockService(bootstrapStub(homeDir, 'client_b'), noopLogger);
  });

  afterEach(() => {
    serviceA.dispose();
    serviceB.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('hold publishes a lock and release removes it', () => {
    serviceA.hold(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    const holder = readLockFile(homeDir, SID);
    expect(holder.pid).toBe(process.pid);
    expect(holder.clientIdentity).toBe('client_a');
    serviceA.release(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
  });

  it('hold is re-entrant within the same process', () => {
    serviceA.hold(SID);
    expect(() => serviceA.hold(SID)).not.toThrow();
    const lease = serviceA.lease(SID);
    expect(() => serviceA.hold(SID)).not.toThrow();
    lease.release();
    serviceA.release(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
  });

  it('throws session.occupied with holder details when another client holds the lock', () => {
    serviceA.hold(SID);
    let caught: unknown;
    try {
      serviceB.hold(SID);
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.occupied');
    const holder = (caught as { details?: { holder?: SessionLockHolder } }).details?.holder;
    expect(holder?.clientIdentity).toBe('client_a');
    expect(holder?.pid).toBe(process.pid);
    expect(serviceB.held(SID)).toBe(false);
  });

  it('reclaims a lock whose owner is dead', () => {
    const stale: SessionLockHolder = {
      version: 1,
      token: 'dead-token',
      pid: 1,
      hostname: '',
      startedAt: 0,
      clientIdentity: 'ghost',
    };
    serviceA.hold('warmup');
    serviceA.release('warmup');
    writeFileSync(lockPath(homeDir, SID), JSON.stringify(stale), { mode: 0o600 });
    expect(() => serviceA.hold(SID)).not.toThrow();
    expect(readLockFile(homeDir, SID).token).not.toBe('dead-token');
    serviceA.release(SID);
  });

  it('treats a lock from another hostname as occupied even when the pid is dead', () => {
    const foreign: SessionLockHolder = {
      version: 1,
      token: 'foreign-token',
      pid: 1,
      hostname: 'definitely-not-this-host',
      startedAt: 0,
      clientIdentity: 'ghost',
    };
    serviceA.hold('warmup');
    serviceA.release('warmup');
    writeFileSync(lockPath(homeDir, SID), JSON.stringify(foreign), { mode: 0o600 });
    expect(() => serviceA.hold(SID)).toThrowError(/in use by another Kimi Code process/);
    expect(readLockFile(homeDir, SID).token).toBe('foreign-token');
  });

  it('a lease keeps the lock through release until it is released', () => {
    const lease = serviceA.lease(SID);
    serviceA.hold(SID);
    serviceA.release(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    expect(() => serviceB.hold(SID)).toThrowError(/in use by another Kimi Code process/);
    lease.release();
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
    expect(() => serviceB.hold(SID)).not.toThrow();
    serviceB.release(SID);
  });

  it('continues without a lock when the lock directory is not writable', () => {
    const blockedHome = join(homeDir, 'blocked');
    writeFileSync(blockedHome, 'not a directory');
    const degraded = new SessionLockService(bootstrapStub(blockedHome), noopLogger);
    expect(() => degraded.hold(SID)).not.toThrow();
    expect(degraded.held(SID)).toBe(true);
    expect(() => degraded.release(SID)).not.toThrow();
    degraded.dispose();
  });

  it('releases held locks when the process exit hook fires', () => {
    const onSpy = vi.spyOn(process, 'on');
    const offSpy = vi.spyOn(process, 'off');
    try {
      serviceA.hold(SID);
      serviceA.hold('other');
      expect(existsSync(lockPath(homeDir, SID))).toBe(true);
      const exitCalls = onSpy.mock.calls.filter(([event]) => event === 'exit');
      expect(exitCalls).toHaveLength(1);
      const exitListener = exitCalls[0]?.[1] as () => void;
      exitListener();
      expect(existsSync(lockPath(homeDir, SID))).toBe(false);
      expect(existsSync(lockPath(homeDir, 'other'))).toBe(false);
      expect(offSpy.mock.calls.filter(([event]) => event === 'exit')).toHaveLength(1);
    } finally {
      onSpy.mockRestore();
      offSpy.mockRestore();
    }
  });
});
