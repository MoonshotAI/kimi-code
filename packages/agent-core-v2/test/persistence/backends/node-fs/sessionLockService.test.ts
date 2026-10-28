import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isError2 } from '#/_base/errors/errors';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { SessionLockHolder } from '#/persistence/interface/sessionLock';
import {
  SESSION_LOCK_ENV,
  SessionLockService,
} from '#/persistence/backends/node-fs/sessionLockService';
import { noopLogger } from '../../../wire/stubs';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: mocks.execFileSync,
}));

const SID = 'session-1';

function bootstrapStub(
  homeDir: string,
  platform = 'test_client',
  env: Record<string, string> = {},
  userAgentSuffix?: string,
): IBootstrapService {
  return {
    homeDir,
    clientIdentity: { productName: 'test', version: '0.0.0', platform, userAgentSuffix },
    getEnv: (name: string) => env[name],
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
    mocks.execFileSync.mockReturnValue('S\n');
    homeDir = mkdtempSync(join(tmpdir(), 'session-lock-'));
    serviceA = new SessionLockService(bootstrapStub(homeDir, 'client_a'), noopLogger);
    serviceB = new SessionLockService(bootstrapStub(homeDir, 'client_b'), noopLogger);
  });

  afterEach(() => {
    serviceA.dispose();
    serviceB.dispose();
    rmSync(homeDir, { recursive: true, force: true });
    mocks.execFileSync.mockReset();
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

  it.each([
    {
      platform: 'kimi_code_cli',
      userAgentSuffix: undefined,
      displayName: 'Kimi Code CLI',
    },
    {
      platform: 'kimi_code_desktop',
      userAgentSuffix: undefined,
      displayName: 'Kimi Code Desktop',
    },
    {
      platform: 'kimi_code_cli',
      userAgentSuffix: 'web',
      displayName: 'Kimi Code Web',
    },
    {
      platform: 'kimi_code_vscode',
      userAgentSuffix: undefined,
      displayName: 'Kimi Code for VS Code',
    },
  ])('names $displayName in the occupied error', ({ platform, userAgentSuffix, displayName }) => {
    const lockingService = new SessionLockService(
      bootstrapStub(homeDir, platform, {}, userAgentSuffix),
      noopLogger,
    );
    try {
      lockingService.hold(SID);
      expect(() => {
        serviceB.hold(SID);
      }).toThrowError(
        `This session is in use by another ${displayName} instance. Stop the session in that instance or exit it, then try again.`,
      );
    } finally {
      lockingService.dispose();
    }
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

  it.skipIf(process.platform === 'win32')('reclaims a lock whose owner is a zombie', () => {
    const stale: SessionLockHolder = {
      version: 1,
      token: 'zombie-token',
      pid: process.pid,
      hostname: '',
      startedAt: Date.now(),
      clientIdentity: 'ghost',
    };
    serviceA.hold('warmup');
    serviceA.release('warmup');
    writeFileSync(lockPath(homeDir, SID), JSON.stringify(stale), { mode: 0o600 });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    mocks.execFileSync.mockReturnValue('Z\n');
    try {
      expect(() => serviceA.hold(SID)).not.toThrow();
      expect(readLockFile(homeDir, SID).token).not.toBe('zombie-token');
      expect(mocks.execFileSync).toHaveBeenCalled();
      serviceA.release(SID);
    } finally {
      killSpy.mockRestore();
    }
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

  it('takeover evicts a live holder and leaves the new lock alone when the old holder releases', () => {
    serviceB.hold(SID);
    expect(() => serviceA.hold(SID)).toThrowError(/in use by another Kimi Code process/);
    serviceA.takeover(SID);
    serviceA.hold(SID);
    const token = readLockFile(homeDir, SID).token;
    serviceB.release(SID);
    expect(readLockFile(homeDir, SID).token).toBe(token);
    expect(() => serviceB.hold(SID)).toThrowError(/in use by another Kimi Code process/);
    serviceA.release(SID);
  });

  it('takeover evicts a lock from another hostname', () => {
    serviceA.hold('warmup');
    serviceA.release('warmup');
    writeFileSync(
      lockPath(homeDir, SID),
      JSON.stringify({
        version: 1,
        token: 'foreign-token',
        pid: 1,
        hostname: 'definitely-not-this-host',
        startedAt: 0,
        clientIdentity: 'ghost',
      } satisfies SessionLockHolder),
      { mode: 0o600 },
    );
    serviceA.takeover(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
    expect(() => serviceA.hold(SID)).not.toThrow();
    serviceA.release(SID);
  });

  it('takeover evicts the lock even when a stale reclaim marker is left behind', () => {
    const foreign = JSON.stringify({
      version: 1,
      token: 'foreign-token',
      pid: 1,
      hostname: 'definitely-not-this-host',
      startedAt: 0,
      clientIdentity: 'ghost',
    } satisfies SessionLockHolder);
    serviceA.hold('warmup');
    serviceA.release('warmup');
    writeFileSync(lockPath(homeDir, SID), foreign, { mode: 0o600 });
    writeFileSync(`${lockPath(homeDir, SID)}.reclaim`, foreign, { mode: 0o600 });
    serviceA.takeover(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
    expect(() => serviceA.hold(SID)).not.toThrow();
    serviceA.release(SID);
  });

  it('takeover reports a lock file it cannot remove', () => {
    serviceB.hold(SID);
    const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw denied;
    });
    try {
      expect(() => serviceA.takeover(SID)).toThrow(denied);
    } finally {
      unlinkSpy.mockRestore();
    }
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    serviceB.release(SID);
  });

  it('takeover keeps a lock this service already holds', () => {
    serviceA.hold(SID);
    const token = readLockFile(homeDir, SID).token;
    serviceA.takeover(SID);
    expect(readLockFile(homeDir, SID).token).toBe(token);
    serviceA.release(SID);
  });

  it('skips the lock file when KIMI_CODE_SESSION_LOCK is off', () => {
    const unlocked = new SessionLockService(
      bootstrapStub(homeDir, 'client_c', { [SESSION_LOCK_ENV]: '0' }),
      noopLogger,
    );
    serviceB.hold(SID);
    expect(() => unlocked.hold(SID)).not.toThrow();
    expect(unlocked.held(SID)).toBe(true);
    unlocked.release(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    serviceB.release(SID);
    unlocked.dispose();
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
