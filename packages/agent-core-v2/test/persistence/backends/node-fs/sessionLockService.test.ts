import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  beginSessionRun,
  type SessionLockHolder,
} from '#/persistence/interface/sessionLock';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SessionLockService } from '#/persistence/backends/node-fs/sessionLockService';

const SID = 'session-1';
const SCOPE = 'sessions/ws1/session-1/agents/main';
const KEY = 'wire.jsonl';

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
    serviceA = new SessionLockService(bootstrapStub(homeDir, 'client_a'));
    serviceB = new SessionLockService(bootstrapStub(homeDir, 'client_b'));
  });

  afterEach(() => {
    serviceA.dispose();
    serviceB.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('beginRun publishes a lock and endRun removes it', () => {
    serviceA.beginRun(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    const holder = readLockFile(homeDir, SID);
    expect(holder.pid).toBe(process.pid);
    expect(holder.clientIdentity).toBe('client_a');
    serviceA.endRun(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
  });

  it('beginRun is re-entrant within the same process', () => {
    serviceA.beginRun(SID);
    expect(() => serviceA.beginRun(SID)).not.toThrow();
    const lease = serviceA.acquire(SID);
    expect(() => serviceA.beginRun(SID)).not.toThrow();
    lease.release();
    serviceA.endRun(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
  });

  it('throws session.occupied with holder details when another client holds the lock', () => {
    serviceA.beginRun(SID);
    let caught: unknown;
    try {
      serviceB.beginRun(SID);
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
    serviceA.beginRun('warmup');
    serviceA.endRun('warmup');
    writeFileSync(lockPath(homeDir, SID), JSON.stringify(stale), { mode: 0o600 });
    expect(() => serviceA.beginRun(SID)).not.toThrow();
    expect(readLockFile(homeDir, SID).token).not.toBe('dead-token');
    serviceA.endRun(SID);
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
    serviceA.beginRun('warmup');
    serviceA.endRun('warmup');
    writeFileSync(lockPath(homeDir, SID), JSON.stringify(foreign), { mode: 0o600 });
    expect(() => serviceA.beginRun(SID)).toThrowError(/in use by another Kimi Code process/);
    expect(readLockFile(homeDir, SID).token).toBe('foreign-token');
  });

  it('explicit lease keeps the lock through endRun until released', () => {
    const lease = serviceA.acquire(SID);
    serviceA.beginRun(SID);
    serviceA.endRun(SID);
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    expect(() => serviceB.beginRun(SID)).toThrowError(/in use by another Kimi Code process/);
    lease.release();
    expect(existsSync(lockPath(homeDir, SID))).toBe(false);
    expect(() => serviceB.beginRun(SID)).not.toThrow();
    serviceB.endRun(SID);
  });

  it('does not unlink a lock owned by someone else on release', () => {
    serviceA.beginRun(SID);
    const leaseB = serviceB.acquire('other-session');
    leaseB.release();
    expect(existsSync(lockPath(homeDir, SID))).toBe(true);
    serviceA.endRun(SID);
  });

  it('continues without a lock when the lock directory is not writable', () => {
    const blockedHome = join(homeDir, 'blocked');
    writeFileSync(blockedHome, 'not a directory');
    const degraded = new SessionLockService(bootstrapStub(blockedHome));
    expect(() => degraded.beginRun(SID)).not.toThrow();
    expect(degraded.held(SID)).toBe(true);
    expect(() => degraded.endRun(SID)).not.toThrow();
    degraded.dispose();
  });

  it('releases held locks when the process exit hook fires', async () => {
    vi.resetModules();
    const fresh = await import('#/persistence/backends/node-fs/sessionLockService');
    const onSpy = vi.spyOn(process, 'on');
    try {
      const freshService = new fresh.SessionLockService(bootstrapStub(homeDir, 'client_fresh'));
      freshService.beginRun(SID);
      expect(existsSync(lockPath(homeDir, SID))).toBe(true);
      const exitCalls = onSpy.mock.calls.filter(([event]) => event === 'exit');
      expect(exitCalls).toHaveLength(1);
      const exitListener = exitCalls[0]?.[1] as () => void;
      exitListener();
      expect(existsSync(lockPath(homeDir, SID))).toBe(false);
      freshService.dispose();
    } finally {
      onSpy.mockRestore();
    }
  });
});

describe('beginSessionRun', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let log: IAppendLogStore;
  let serviceA: SessionLockService;
  let serviceB: SessionLockService;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'session-lock-run-'));
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new FileStorageService(homeDir));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    serviceA = new SessionLockService(bootstrapStub(homeDir, 'client_a'));
    serviceB = new SessionLockService(bootstrapStub(homeDir, 'client_b'));
  });

  afterEach(() => {
    serviceA.dispose();
    serviceB.dispose();
    disposables.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function readAll(): Promise<void> {
    for await (const _ of log.read(SCOPE, KEY)) {
      void _;
    }
  }

  function writeExternally(text: string): void {
    const filePath = join(homeDir, SCOPE, KEY);
    mkdirSync(join(homeDir, SCOPE), { recursive: true });
    appendFileSync(filePath, text);
  }

  it('acquires the lock on a fresh session', async () => {
    await readAll();
    expect(() => beginSessionRun(serviceA, log, SID, SCOPE, KEY)).not.toThrow();
    expect(serviceA.held(SID)).toBe(true);
    serviceA.endRun(SID);
  });

  it('throws session.stale and releases when the wire changed on disk', async () => {
    await readAll();
    writeExternally(`${JSON.stringify({ type: 'metadata', protocol_version: 1 })}\n`);
    let caught: unknown;
    try {
      beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.stale');
    expect(serviceA.held(SID)).toBe(false);
  });

  it('checks staleness once per lock hold, not per run', async () => {
    await readAll();
    const spy = vi.spyOn(log, 'externallyModified');
    beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    expect(spy).toHaveBeenCalledTimes(1);
    serviceA.endRun(SID);
    beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    expect(spy).toHaveBeenCalledTimes(2);
    serviceA.endRun(SID);
  });

  it('checks staleness even when the lock was already acquired by another path', async () => {
    await readAll();
    serviceA.beginRun(SID);
    writeExternally(`${JSON.stringify({ type: 'metadata', protocol_version: 1 })}\n`);
    let caught: unknown;
    try {
      beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.stale');
    expect(serviceA.held(SID)).toBe(false);
  });

  it('passes after own appends are flushed', async () => {
    await readAll();
    beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    log.append(SCOPE, KEY, { type: 'metadata', protocol_version: 1 });
    await log.flush();
    expect(() => beginSessionRun(serviceA, log, SID, SCOPE, KEY)).not.toThrow();
    serviceA.endRun(SID);
  });

  it('throws session.occupied when another client runs the session', async () => {
    await readAll();
    serviceB.beginRun(SID);
    let caught: unknown;
    try {
      beginSessionRun(serviceA, log, SID, SCOPE, KEY);
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('session.occupied');
    serviceB.endRun(SID);
  });
});
