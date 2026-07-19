/**
 * `crossProcessLock` domain — integration tests for the node-local lock
 * service against a real temporary directory.
 *
 * Every test constructs the service with the full fake seam (clock, self pid,
 * process probe, token source, sleep) and asserts the on-disk file names and
 * snake_case payload keys, not just in-memory state. Dead-pid simulation for
 * the real probe uses `0x7fffffff` (guaranteed ESRCH), mirroring kap-server's
 * lock tests. Timed tests use real short sleep; the fake clock is advanced by
 * hand where the protocol depends on wall-clock values.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CrossProcessLockService } from '#/os/backends/node-local/crossProcessLockService';
import { createNodeProcessProbe } from '#/os/backends/node-local/processProbe';
import {
  CrossProcessLockErrorCode,
  type ICrossProcessLockHandle,
  type ProcessProbe,
} from '#/os/interface/crossProcessLock';

const SELF_PID = 1001;
const OTHER_PID = 2002;
/** Max signed-32 pid; the kernel never allocates it, so `kill(pid, 0)` → ESRCH. */
const DEAD_PID = 0x7fffffff;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

let tmpDir: string;
let lockPath: string;
let nowValue: number;
let lockSeq: number;
const handles: ICrossProcessLockHandle[] = [];

function track<T extends ICrossProcessLockHandle>(handle: T): T {
  handles.push(handle);
  return handle;
}

function probeFor(live: ReadonlyMap<number, string | undefined>): ProcessProbe {
  return (pid) => {
    if (!live.has(pid)) return { alive: false };
    const startedAt = live.get(pid);
    return startedAt === undefined
      ? { alive: true }
      : { alive: true, processStartedAt: startedAt };
  };
}

interface FakeServiceOptions {
  selfPid?: number;
  instanceId?: string;
  probe?: ProcessProbe;
  now?: () => number;
}

function makeService(options: FakeServiceOptions = {}): CrossProcessLockService {
  const selfPid = options.selfPid ?? SELF_PID;
  return new CrossProcessLockService({
    selfPid,
    instanceId: options.instanceId ?? 'inst-self',
    probeProcess: options.probe ?? probeFor(new Map([[selfPid, 'self-start']])),
    now: options.now ?? (() => nowValue),
    newLockId: () => `lockid-${++lockSeq}`,
    sleep: realSleep,
  });
}

function liveWorld(): Map<number, string | undefined> {
  return new Map<number, string | undefined>([
    [SELF_PID, 'self-start'],
    [OTHER_PID, 'other-start'],
  ]);
}

function writePayload(payload: Record<string, unknown>): void {
  writeFileSync(lockPath, JSON.stringify(payload));
}

interface DiskLockJson {
  lock_id?: string;
  instance_id?: string;
  pid?: number;
  process_started_at?: string;
  address?: string;
  heartbeat_at?: number;
  port?: number;
  [extra: string]: unknown;
}

function readDisk(): DiskLockJson {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as DiskLockJson;
}

function backdate(path: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await realSleep(10);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cplock-test-'));
  lockPath = join(tmpDir, 'lock');
  nowValue = 1_000_000;
  lockSeq = 0;
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.release();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquire / release', () => {
  it('writes the snake_case payload with extras flat, and release removes the file', () => {
    const svc = makeService();
    const handle = track(
      svc.acquire(lockPath, {
        address: '127.0.0.1:58627',
        extraPayload: { port: 58627, role: 'primary' },
      }),
    );
    expect(handle.lockId).toBe('lockid-1');
    expect(readDisk()).toEqual({
      lock_id: 'lockid-1',
      instance_id: 'inst-self',
      pid: SELF_PID,
      process_started_at: 'self-start',
      address: '127.0.0.1:58627',
      port: 58627,
      role: 'primary',
    });

    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('omits optional keys when the platform cannot provide them', () => {
    const svc = makeService({ probe: () => ({ alive: true }) });
    const handle = track(svc.acquire(lockPath));
    expect(readDisk()).toEqual({
      lock_id: 'lockid-1',
      instance_id: 'inst-self',
      pid: SELF_PID,
    });
  });

  it('creates missing parent directories and release is idempotent', () => {
    const nested = join(tmpDir, 'a', 'b', 'lock');
    const svc = makeService();
    const handle = track(svc.acquire(nested));
    expect(existsSync(nested)).toBe(true);
    handle.release();
    handle.release();
    expect(existsSync(nested)).toBe(false);
  });

  it('release never unlinks a foreign lock', () => {
    const svc = makeService();
    const handle = track(svc.acquire(lockPath));
    handle.release();
    writePayload({ lock_id: 'someone-else', instance_id: 'x', pid: OTHER_PID });
    handle.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readDisk().lock_id).toBe('someone-else');
  });
});

describe('held vs takeover', () => {
  it('a live identity-matching holder blocks acquisition with OS_LOCK_HELD', () => {
    writePayload({
      lock_id: 'old-id',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'other-start',
    });
    const svc = makeService({ probe: probeFor(liveWorld()) });
    const before = readFileSync(lockPath, 'utf8');

    let caught: unknown;
    try {
      svc.acquire(lockPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { reason: 'held' },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
    expect(readdirSync(tmpDir)).toEqual(['lock']);
  });

  it('takes over a dead holder with rename isolation', () => {
    const live = liveWorld();
    const probe = probeFor(live);
    const oldHandle = track(
      makeService({ selfPid: OTHER_PID, instanceId: 'inst-other', probe }).acquire(
        lockPath,
        { extraPayload: { port: 1 } },
      ),
    );
    const oldDisk = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;

    live.delete(OTHER_PID);
    const handle = track(makeService({ probe }).acquire(lockPath));

    expect(existsSync(`${lockPath}.stale.lockid-1`)).toBe(true);
    expect(JSON.parse(readFileSync(`${lockPath}.stale.lockid-1`, 'utf8'))).toEqual(oldDisk);
    expect(readDisk().lock_id).toBe('lockid-2');
    expect(handle.lockId).toBe('lockid-2');

    expect(oldHandle.checkHeld()).toBe(false);
    oldHandle.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(readDisk().lock_id).toBe('lockid-2');
  });

  it('treats a live pid with mismatched identity as stale (pid reused)', () => {
    writePayload({
      lock_id: 'old-id',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'original-start',
    });
    const live = liveWorld();
    live.set(OTHER_PID, 'reused-start');
    const svc = makeService({ probe: probeFor(live) });

    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'stale',
      staleReason: 'pid-reused',
    });
    track(svc.acquire(lockPath));
    expect(existsSync(`${lockPath}.stale.old-id`)).toBe(true);
    expect(readDisk().lock_id).toBe('lockid-1');
  });

  it('refuses takeover when the holder identity is unavailable (conservative held)', () => {
    writePayload({
      lock_id: 'old-id',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'original-start',
    });
    const live = liveWorld();
    live.set(OTHER_PID, undefined);
    const svc = makeService({ probe: probeFor(live) });

    expect(svc.inspect(lockPath)).toMatchObject({ state: 'held', unavailableReason: 'held' });
    expect(() => svc.acquire(lockPath)).toThrowError(
      expect.objectContaining({ code: CrossProcessLockErrorCode.Held }),
    );
    expect(readDisk().lock_id).toBe('old-id');
    expect(readdirSync(tmpDir)).toEqual(['lock']);
  });

  it('takes over a legacy payload without lock_id, renamed aside as unknown', () => {
    writePayload({ pid: OTHER_PID, started_at: '1', port: 58627 });
    const svc = makeService();

    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'stale',
      staleReason: 'holder-dead',
      payload: { lockId: '', pid: OTHER_PID, port: 58627 },
    });
    track(svc.acquire(lockPath));
    expect(existsSync(`${lockPath}.stale.unknown`)).toBe(true);
    expect(readDisk().lock_id).toBe('lockid-1');
  });
});

describe('creation window', () => {
  it('an empty file inside the window is creating', () => {
    writeFileSync(lockPath, '');
    const svc = makeService({ now: () => Date.now() });

    expect(svc.inspect(lockPath)).toMatchObject({ state: 'creating' });
    let caught: unknown;
    try {
      svc.acquire(lockPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { reason: 'creating' },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('');
    expect(readdirSync(tmpDir)).toEqual(['lock']);
  });

  it('an empty file past the window is taken over as stale', () => {
    writeFileSync(lockPath, '');
    backdate(lockPath, 10_000);
    const svc = makeService({ now: () => Date.now() });

    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'stale',
      staleReason: 'creation-window-expired',
    });
    track(svc.acquire(lockPath));
    expect(existsSync(`${lockPath}.stale.unknown`)).toBe(true);
    expect(readDisk().lock_id).toBe('lockid-1');
  });

  it('an unparseable file follows the same window', () => {
    writeFileSync(lockPath, '{oops');
    const svc = makeService({ now: () => Date.now() });

    expect(svc.inspect(lockPath)).toMatchObject({ state: 'creating' });
    backdate(lockPath, 10_000);
    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'stale',
      staleReason: 'creation-window-expired',
    });
    track(svc.acquire(lockPath));
    expect(existsSync(`${lockPath}.stale.unknown`)).toBe(true);
    expect(readDisk().instance_id).toBe('inst-self');
  });
});

describe('heartbeat mode', () => {
  it('beats heartbeat_at into the disk payload through the kept fd', async () => {
    const svc = makeService();
    const handle = track(
      svc.acquire(lockPath, { heartbeat: { intervalMs: 20, ttlMs: 60_000 } }),
    );
    expect(readDisk().heartbeat_at).toBe(1_000_000);

    nowValue = 1_000_500;
    await waitFor(() => readDisk().heartbeat_at === 1_000_500);
    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a taken-over holder detects the loss on its next beat and fires onLost exactly once', async () => {
    const live = liveWorld();
    const probe = probeFor(live);
    let lostCount = 0;
    const oldHandle = track(
      makeService({ probe }).acquire(lockPath, {
        heartbeat: { intervalMs: 20, ttlMs: 60_000 },
        onLost: () => {
          lostCount += 1;
        },
      }),
    );

    live.delete(SELF_PID);
    track(
      makeService({ selfPid: OTHER_PID, instanceId: 'inst-b', probe }).acquire(lockPath),
    );

    await waitFor(() => lostCount === 1);
    await realSleep(100);
    expect(lostCount).toBe(1);
    expect(oldHandle.checkHeld()).toBe(false);
    expect(readDisk().lock_id).toBe('lockid-2');
  });

  it('a silent heartbeat with a live identity-matching pid is holder-unresponsive, never seized', () => {
    writePayload({
      lock_id: 'old-id',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'other-start',
      heartbeat_at: nowValue - 10_000,
    });
    const svc = makeService({ probe: probeFor(liveWorld()) });
    const before = readFileSync(lockPath, 'utf8');

    let caught: unknown;
    try {
      svc.acquire(lockPath, { heartbeat: { intervalMs: 100, ttlMs: 5_000 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { reason: 'holder-unresponsive' },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
    expect(readdirSync(tmpDir)).toEqual(['lock']);
  });

  it('a fresh heartbeat with a live holder is a plain held', () => {
    writePayload({
      lock_id: 'old-id',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'other-start',
      heartbeat_at: nowValue - 100,
    });
    const svc = makeService({ probe: probeFor(liveWorld()) });

    let caught: unknown;
    try {
      svc.acquire(lockPath, { heartbeat: { intervalMs: 100, ttlMs: 5_000 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: CrossProcessLockErrorCode.Held,
      details: { reason: 'held' },
    });
    expect(readDisk().lock_id).toBe('old-id');
  });
});

describe('acquireWithWait / withLock', () => {
  it('a waiting acquirer obtains the lock after the holder releases', async () => {
    const live = liveWorld();
    const probe = probeFor(live);
    const holder = track(makeService({ probe }).acquire(lockPath));

    const waiter = makeService({
      selfPid: OTHER_PID,
      instanceId: 'inst-b',
      probe,
      now: () => Date.now(),
    });
    const acquired: string[] = [];
    const pending = waiter.withLock(
      lockPath,
      { wait: { timeoutMs: 5_000, retryIntervalMs: 5 } },
      (handle) => {
        acquired.push(handle.lockId);
        return 'done';
      },
    );
    await realSleep(50);
    holder.release();

    await expect(pending).resolves.toBe('done');
    expect(acquired).toEqual(['lockid-2']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a waiting acquirer gives up with OS_LOCK_WAIT_TIMEOUT', async () => {
    const live = liveWorld();
    const probe = probeFor(live);
    track(makeService({ probe }).acquire(lockPath));

    const waiter = makeService({
      selfPid: OTHER_PID,
      instanceId: 'inst-b',
      probe,
      now: () => Date.now(),
    });
    await expect(
      waiter.acquireWithWait(lockPath, { wait: { timeoutMs: 100, retryIntervalMs: 5 } }),
    ).rejects.toMatchObject({ code: CrossProcessLockErrorCode.WaitTimeout });
    expect(readDisk().lock_id).toBe('lockid-1');
  });
});

describe('update', () => {
  it('rewrites extras and re-stamps the protocol keys', () => {
    const svc = makeService();
    const handle = track(svc.acquire(lockPath, { extraPayload: { port: 1 } }));

    handle.update((payload) => ({
      ...payload,
      port: 58627,
      lockId: 'evil',
      instanceId: 'evil',
      pid: 9999,
    }));
    expect(readDisk()).toEqual({
      lock_id: 'lockid-1',
      instance_id: 'inst-self',
      pid: SELF_PID,
      process_started_at: 'self-start',
      port: 58627,
    });
    expect(handle.lockId).toBe('lockid-1');
  });

  it('a later update keeps the extras the heartbeat rewrites', async () => {
    const svc = makeService();
    const handle = track(
      svc.acquire(lockPath, {
        heartbeat: { intervalMs: 20, ttlMs: 60_000 },
        extraPayload: { port: 1 },
      }),
    );
    handle.update((payload) => ({ ...payload, port: 58627 }));
    nowValue = 1_000_700;
    await waitFor(
      () => readDisk().port === 58627 && readDisk().heartbeat_at === 1_000_700,
    );
    expect(readDisk()).toMatchObject({
      lock_id: 'lockid-1',
      port: 58627,
      heartbeat_at: 1_000_700,
    });
    handle.release();
  });

  it('update after a takeover throws OS_LOCK_LOST', () => {
    const live = liveWorld();
    const probe = probeFor(live);
    const oldHandle = track(
      makeService({ probe }).acquire(lockPath, { extraPayload: { port: 1 } }),
    );
    live.delete(SELF_PID);
    track(
      makeService({ selfPid: OTHER_PID, instanceId: 'inst-b', probe }).acquire(lockPath),
    );

    expect(() => {
      oldHandle.update((payload) => ({ ...payload, port: 2 }));
    }).toThrowError(expect.objectContaining({ code: CrossProcessLockErrorCode.Lost }));
    expect(readDisk().lock_id).toBe('lockid-2');
    expect(readDisk().port).toBeUndefined();
  });
});

describe('inspect', () => {
  it('free when the file is missing', () => {
    const svc = makeService();
    expect(svc.inspect(lockPath)).toEqual({ state: 'free' });
  });

  it('held with payload passthrough for a live holder', () => {
    writePayload({
      lock_id: 'x',
      instance_id: 'inst-other',
      pid: OTHER_PID,
      process_started_at: 'other-start',
      address: '127.0.0.1:1',
      port: 58627,
    });
    const svc = makeService({ probe: probeFor(liveWorld()) });

    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'held',
      unavailableReason: 'held',
      payload: {
        lockId: 'x',
        instanceId: 'inst-other',
        pid: OTHER_PID,
        processStartedAt: 'other-start',
        address: '127.0.0.1:1',
        port: 58627,
      },
    });
  });

  it('stale holder-dead for a gone pid', () => {
    writePayload({ lock_id: 'x', instance_id: 'inst-other', pid: OTHER_PID });
    const svc = makeService();
    expect(svc.inspect(lockPath)).toMatchObject({
      state: 'stale',
      staleReason: 'holder-dead',
      payload: { lockId: 'x', pid: OTHER_PID },
    });
  });
});

describe('createNodeProcessProbe', () => {
  it('reports the current process alive with a stable identity token', () => {
    const probe = createNodeProcessProbe();
    const first = probe(process.pid);
    expect(first.alive).toBe(true);
    // Modern macOS exposes no named per-pid starttime OID, so the token is
    // legitimately absent on darwin; linux always has one via /proc.
    if (process.platform === 'linux') {
      expect(first.processStartedAt).toBeDefined();
    }
    if (first.processStartedAt !== undefined) {
      expect(probe(process.pid).processStartedAt).toBe(first.processStartedAt);
    }
  });

  it('reports a guaranteed-absent pid dead, without a token', () => {
    const probe = createNodeProcessProbe();
    expect(probe(DEAD_PID)).toEqual({ alive: false });
  });
});
