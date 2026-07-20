/**
 * `sessionFileLedger` domain (L2) — verifies the optimistic-concurrency
 * verdict matrix (clean / stale / no-baseline) against a real tmpdir, a real
 * `HostFileSystem` (stat-call counted) and a fake os watcher: baselines only
 * refresh on success, every write decision performs a fresh stat, dirty ticks
 * arrive before debounced event delivery, watcher echoes of the session's own
 * writes re-baseline, and truncated windows retain conservative root ticks.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionFileLedger } from '#/session/sessionFileLedger/fileLedger';
import { SessionFileLedger } from '#/session/sessionFileLedger/fileLedgerService';
import { ISessionFsWatchService } from '#/session/sessionFs/fsWatch';
import { SessionFsWatchService } from '#/session/sessionFs/fsWatchService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';

import { fakeHostFsWatch, type FakeWatch } from '../sessionFs/stubs';

void SessionFileLedger;
void SessionFsWatchService;
void SessionWorkspaceContextService;

const JUNK_EVENT_COUNT = 501;

function countingHostFs(poisonedPaths: Set<string>): {
  fs: IHostFileSystem;
  statCalls: () => number;
} {
  const real = new HostFileSystem();
  let count = 0;
  const fs = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'stat') {
        return async (path: string) => {
          count += 1;
          if (poisonedPaths.has(path)) {
            const err = new Error(`EACCES: permission denied, stat '${path}'`) as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return target.stat(path);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as IHostFileSystem;
  return { fs, statCalls: () => count };
}

interface World {
  readonly workDir: string;
  readonly outsideDir: string;
  readonly fs: IHostFileSystem;
  readonly ledger: ISessionFileLedger;
  readonly watch: ISessionFsWatchService;
  readonly workspace: ISessionWorkspaceContext;
  readonly fake: FakeWatch;
  readonly statCalls: () => number;
  readonly poisonedPaths: Set<string>;
}

function makeWorld(): World {
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-ledger-work-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'kimi-ledger-out-'));
  cleanupPaths.push(workDir, outsideDir);
  const fake = fakeHostFsWatch();
  const poisonedPaths = new Set<string>();
  const { fs, statCalls } = countingHostFs(poisonedPaths);
  const host = createScopedTestHost([
    stubPair(IHostFileSystem, fs),
    stubPair(IHostFsWatchService, fake.service),
  ]);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(
      ISessionContext,
      makeSessionContext({
        sessionId: 's1',
        workspaceId: 'ws',
        sessionDir: join(workDir, '.session'),
        sessionScope: 'sessions/ws/s1',
        cwd: workDir,
      }),
    ),
  ]);
  hosts.push(host);
  return {
    workDir,
    outsideDir,
    fs,
    ledger: session.accessor.get(ISessionFileLedger),
    watch: session.accessor.get(ISessionFsWatchService),
    workspace: session.accessor.get(ISessionWorkspaceContext),
    fake,
    statCalls,
    poisonedPaths,
  };
}

async function recordCurrentBaseline(world: World, path: string): Promise<void> {
  try {
    const stat = await world.fs.stat(path);
    world.ledger.recordBaseline(path, {
      exists: true,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch (error) {
    const code = (unwrapErrorCause(error) as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    world.ledger.recordBaseline(path, { exists: false });
  }
}

function foldJunkEvents(world: World, count: number = JUNK_EVENT_COUNT): void {
  for (let i = 0; i < count; i++) world.fake.fire(`junk-${i}.tmp`, 'created');
  vi.advanceTimersByTime(200);
}

const hosts: ScopedTestHost[] = [];
const cleanupPaths: string[] = [];

describe('SessionFileLedger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('returns clean for a baselined file with no changes', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');
  });

  it('returns no-baseline for an existing file never read or written', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    expect(await world.ledger.compare(file)).toBe('no-baseline');
  });

  it('returns clean for a missing file (new-file creation is exempt)', async () => {
    const world = makeWorld();
    expect(await world.ledger.compare(join(world.workDir, 'new.txt'))).toBe('clean');
  });

  it('returns stale for a dirty path without a baseline', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    world.fake.fire('a.txt', 'modified');
    vi.advanceTimersByTime(200);

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('returns stale when a baselined file is modified outside the session', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    writeFileSync(file, 'hello world');
    world.fake.fire('a.txt', 'modified');
    vi.advanceTimersByTime(200);

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('detects an outside modification before the watch debounce flush', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    writeFileSync(file, 'hello world');
    world.fake.fire('a.txt', 'modified');

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('absorbs the watcher echo of the session own write and re-baselines the tick', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);
    expect(world.statCalls()).toBe(1);

    world.fake.fire('a.txt', 'modified');
    vi.advanceTimersByTime(200);

    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(2);

    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(3);
  });

  it('keeps a baselined file clean through an untouched truncated window', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    foldJunkEvents(world);
    expect(world.watch.rootDirtyTickFor(world.workDir)).toBeGreaterThan(0);

    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(2);
    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(3);
  });

  it('detects an outside modification through a truncated window via the stat punch', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    writeFileSync(file, 'hello world');
    foldJunkEvents(world);

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('tracks a write-then-delete baseline as non-existence', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    rmSync(file);
    world.fake.fire('a.txt', 'deleted');
    vi.advanceTimersByTime(200);
    expect(await world.ledger.compare(file)).toBe('stale');

    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');

    writeFileSync(file, 'recreated');
    world.fake.fire('a.txt', 'created');
    vi.advanceTimersByTime(200);
    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('falls back to the stat-only comparison outside every watched root', async () => {
    const world = makeWorld();
    const file = join(world.outsideDir, 'b.txt');
    writeFileSync(file, 'hello');

    expect(await world.ledger.compare(file)).toBe('no-baseline');

    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');

    writeFileSync(file, 'hello world');
    expect(await world.ledger.compare(file)).toBe('stale');

    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');

    rmSync(file);
    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('adds a later additional dir as a watched root when a target falls under it', async () => {
    const world = makeWorld();
    expect(world.fake.watchCalls).toEqual([world.workDir]);

    world.workspace.addAdditionalDir(world.outsideDir);
    const file = join(world.outsideDir, 'b.txt');
    writeFileSync(file, 'hello');

    expect(await world.ledger.compare(file)).toBe('no-baseline');
    expect(world.fake.watchCalls).toContain(world.outsideDir);
    expect(world.watch.watchedRoots).toContain(world.outsideDir);

    world.fake.handles
      .find((h) => h.root === world.outsideDir)
      ?.fire('b.txt', 'modified');
    vi.advanceTimersByTime(200);
    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('fails closed when stat fails for reasons other than not-found', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);
    world.poisonedPaths.add(file);

    expect(await world.ledger.compare(file)).toBe('stale');

    world.poisonedPaths.clear();
    await recordCurrentBaseline(world, file);
    world.poisonedPaths.add(file);
    world.fake.fire('a.txt', 'modified');
    vi.advanceTimersByTime(200);

    expect(await world.ledger.compare(file)).toBe('stale');
    expect(world.statCalls()).toBeGreaterThan(0);
  });
});
