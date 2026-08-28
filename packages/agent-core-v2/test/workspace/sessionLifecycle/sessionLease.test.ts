import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '#/index';
import type { Scope } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { logSeed, resolveLoggingConfig } from '#/_base/log/logConfig';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ErrorCodes, isError2, type Error2 } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  type SessionLeaseHolder,
  SessionLeaseManager,
  type SessionLeaseTiming,
  SESSION_LEASE_FILE,
} from '#/workspace/sessionLifecycle/sessionLease';

const noopLog = {
  _serviceBrand: undefined,
  level: 'off',
  setLevel: () => {},
  flush: async () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLog,
} as unknown as ILogService;

const testIdentity = {
  productName: 'session-lease-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

const cleanupDirs: string[] = [];
const cleanupManagers: SessionLeaseManager[] = [];
const cleanupScopes: Scope[] = [];
const fs = new HostFileSystem();

afterEach(async () => {
  for (const manager of cleanupManagers.splice(0)) await manager.releaseAll();
  for (const scope of cleanupScopes.splice(0)) scope.dispose();
  for (const dir of cleanupDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeManager(dir: string, timing?: Partial<SessionLeaseTiming>): SessionLeaseManager {
  const manager = new SessionLeaseManager(fs, noopLog, () => dir, timing);
  cleanupManagers.push(manager);
  return manager;
}

async function readHolderFromDisk(dir: string): Promise<SessionLeaseHolder> {
  return JSON.parse(await readFile(join(dir, SESSION_LEASE_FILE), 'utf8')) as SessionLeaseHolder;
}

async function backdateLease(dir: string, ageMs: number): Promise<void> {
  const file = join(dir, SESSION_LEASE_FILE);
  const past = new Date(Date.now() - ageMs);
  await utimes(file, past, past);
}

async function writeStaleCorpse(dir: string): Promise<void> {
  await writeFile(
    join(dir, SESSION_LEASE_FILE),
    JSON.stringify({
      leaseId: 'dead-lease',
      pid: 2147480000,
      serverId: 'dead-server',
      acquiredAt: Date.now() - 300_000,
      renewedAt: Date.now() - 300_000,
    }),
  );
  await backdateLease(dir, 120_000);
}

async function snapshotDir(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (next === SESSION_LEASE_FILE || next.startsWith('logs')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, next);
      } else if (entry.isFile()) {
        out[next] = (await readFile(path)).toString('base64');
      }
    }
  }
  await walk(root, '');
  return out;
}

async function settle(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

describe('SessionLeaseManager', () => {
  it('rejects a second acquirer with session.locked carrying the holder identity', async () => {
    const dir = await makeTempDir('kimi-lease-');
    const a = makeManager(dir);
    const holder = await a.acquire('s1', () => {});
    expect(holder.pid).toBe(process.pid);
    const b = makeManager(dir);
    let error: unknown;
    try {
      await b.acquire('s1', () => {});
    } catch (caught) {
      error = caught;
    }
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.SESSION_LOCKED);
    expect((error as Error2).details?.['sessionId']).toBe('s1');
    expect((error as Error2).details?.['holder']).toMatchObject({
      leaseId: holder.leaseId,
      pid: process.pid,
      serverId: expect.any(String),
    });
  });

  it('treats re-acquire by the same manager as already held', async () => {
    const dir = await makeTempDir('kimi-lease-');
    const a = makeManager(dir);
    const first = await a.acquire('s1', () => {});
    const second = await a.acquire('s1', () => {});
    expect(second.leaseId).toBe(first.leaseId);
  });

  it('allows another manager to acquire immediately after release', async () => {
    const dir = await makeTempDir('kimi-lease-');
    const a = makeManager(dir);
    await a.acquire('s1', () => {});
    await a.release('s1');
    expect(a.isHeld('s1')).toBe(false);
    const b = makeManager(dir);
    const holder = await b.acquire('s1', () => {});
    expect((await readHolderFromDisk(dir)).leaseId).toBe(holder.leaseId);
  });

  it('takes over a lease whose heartbeat expired and gives exactly one winner', async () => {
    const dir = await makeTempDir('kimi-lease-');
    await writeStaleCorpse(dir);
    const a = makeManager(dir);
    const b = makeManager(dir);
    const [first, second] = await Promise.allSettled([
      a.acquire('s1', () => {}),
      b.acquire('s1', () => {}),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(isError2(rejected?.reason)).toBe(true);
    expect((rejected as PromiseRejectedResult).reason.code).toBe(ErrorCodes.SESSION_LOCKED);
    const winnerLeaseId =
      first.status === 'fulfilled' ? first.value.leaseId
      : second.status === 'fulfilled' ? second.value.leaseId
      : undefined;
    expect((await readHolderFromDisk(dir)).leaseId).toBe(winnerLeaseId);
  });

  it('renews the heartbeat so a live lock stays respected past the staleness window', async () => {
    const dir = await makeTempDir('kimi-lease-');
    const a = makeManager(dir, { renewIntervalMs: 25, staleAfterMs: 60_000 });
    await a.acquire('s1', () => {});
    const b = makeManager(dir, { staleAfterMs: 80 });
    await settle(160);
    await expect(b.acquire('s1', () => {})).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LOCKED,
    });
  });

  it('reports loss when the lease is replaced and never removes the new holder file', async () => {
    const dir = await makeTempDir('kimi-lease-');
    const a = makeManager(dir, { renewIntervalMs: 25, staleAfterMs: 60_000 });
    let lostCalls = 0;
    let resolveLost!: () => void;
    const lost = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    await a.acquire('s1', () => {
      lostCalls += 1;
      resolveLost();
    });
    await backdateLease(dir, 120_000);
    const b = makeManager(dir);
    const holder = await b.acquire('s1', () => {});
    await Promise.race([
      lost,
      settle(10_000).then(() => {
        throw new Error('lease loss was not reported in time');
      }),
    ]);
    expect(lostCalls).toBe(1);
    expect(a.isHeld('s1')).toBe(false);
    await a.release('s1');
    expect((await readHolderFromDisk(dir)).leaseId).toBe(holder.leaseId);
  });

  it('rejects when the lock file is unreadable but still fresh', async () => {
    const dir = await makeTempDir('kimi-lease-');
    await writeFile(join(dir, SESSION_LEASE_FILE), 'not-json');
    const b = makeManager(dir);
    await expect(b.acquire('s1', () => {})).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LOCKED,
      details: { sessionId: 's1' },
    });
  });
});

describe('session lease across two engines sharing one home', () => {
  async function makeEngine(homeDir: string) {
    const { app } = bootstrap(
      { homeDir, clientIdentity: testIdentity },
      logSeed(resolveLoggingConfig({ homeDir, env: {} })),
    );
    cleanupScopes.push(app);
    return app;
  }

  it('rejects resume from a second instance and writes nothing to the session directory', async () => {
    const homeDir = await makeTempDir('kimi-lease-home-');
    const workDir = await makeTempDir('kimi-lease-work-');
    const appA = await makeEngine(homeDir);
    const managerA = appA.accessor.get(ISessionManager);
    const handle = await managerA.create({ workDir });
    const ctx = handle.accessor.get(ISessionContext);
    const before = await snapshotDir(ctx.sessionDir);
    const appB = await makeEngine(homeDir);
    const managerB = appB.accessor.get(ISessionManager);
    await expect(managerB.resume(ctx.sessionId)).rejects.toMatchObject({
      code: ErrorCodes.SESSION_LOCKED,
      details: { holder: { pid: process.pid } },
    });
    expect(await snapshotDir(ctx.sessionDir)).toEqual(before);
    await managerA.close(ctx.sessionId);
  }, 120_000);

  it('lets another instance resume immediately after a clean close', async () => {
    const homeDir = await makeTempDir('kimi-lease-home-');
    const workDir = await makeTempDir('kimi-lease-work-');
    const appA = await makeEngine(homeDir);
    const managerA = appA.accessor.get(ISessionManager);
    const handle = await managerA.create({ workDir });
    const ctx = handle.accessor.get(ISessionContext);
    await managerA.close(ctx.sessionId);
    const appB = await makeEngine(homeDir);
    const managerB = appB.accessor.get(ISessionManager);
    const resumed = await managerB.resume(ctx.sessionId);
    expect(resumed).toBeDefined();
    await managerB.close(ctx.sessionId);
  }, 120_000);

  it('takes over an expired lease and evicts the stale in-memory instance', async () => {
    const homeDir = await makeTempDir('kimi-lease-home-');
    const workDir = await makeTempDir('kimi-lease-work-');
    const appA = await makeEngine(homeDir);
    const managerA = appA.accessor.get(ISessionManager);
    const handle = await managerA.create({ workDir });
    const ctx = handle.accessor.get(ISessionContext);
    await backdateLease(ctx.sessionDir, 120_000);
    const appB = await makeEngine(homeDir);
    const managerB = appB.accessor.get(ISessionManager);
    const resumed = await managerB.resume(ctx.sessionId);
    expect(resumed).toBeDefined();
    expect(managerA.get(ctx.sessionId)).toBeDefined();
    await vi.waitFor(
      () => {
        expect(managerA.get(ctx.sessionId)).toBeUndefined();
      },
      { timeout: 30_000, interval: 200 },
    );
    expect(managerB.get(ctx.sessionId)).toBeDefined();
    expect((await readHolderFromDisk(ctx.sessionDir)).pid).toBe(process.pid);
    await managerB.close(ctx.sessionId);
  }, 180_000);
});
