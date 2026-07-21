/**
 * `sessionFileLedger` domain (L2) — verifies the optimistic-concurrency
 * verdict matrix (clean / stale / no-baseline) against a real tmpdir and a
 * real `HostFileSystem` with stat calls counted. Baselines are compared only
 * against fresh stat tuples, and resolving or using the ledger never starts a
 * workspace watcher.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionFileLedger } from '#/session/sessionFileLedger/fileLedger';
import { SessionFileLedger } from '#/session/sessionFileLedger/fileLedgerService';

import { fakeHostFsWatch, type FakeWatch } from '../sessionFs/stubs';

void SessionFileLedger;

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

const hosts: ScopedTestHost[] = [];
const cleanupPaths: string[] = [];

describe('SessionFileLedger', () => {
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
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

  it('does not let watcher signals change the stat-only verdict', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    world.fake.fire('a.txt', 'modified');

    expect(await world.ledger.compare(file)).toBe('no-baseline');
    expect(world.fake.watchCalls).toEqual([]);
  });

  it('returns stale when a baselined file is modified outside the session', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    writeFileSync(file, 'hello world');

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('performs a fresh stat for every comparison', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);
    expect(world.statCalls()).toBe(1);

    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(2);

    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.statCalls()).toBe(3);
  });

  it('detects an outside modification using only the stat tuple', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    writeFileSync(file, 'hello world');

    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('tracks a write-then-delete baseline as non-existence', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);

    rmSync(file);
    expect(await world.ledger.compare(file)).toBe('stale');

    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');

    writeFileSync(file, 'recreated');
    expect(await world.ledger.compare(file)).toBe('stale');
  });

  it('uses the same stat-only comparison outside the workspace', async () => {
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

  it('never starts a watcher when recording or comparing paths', async () => {
    const world = makeWorld();
    const file = join(world.outsideDir, 'b.txt');
    writeFileSync(file, 'hello');

    expect(await world.ledger.compare(file)).toBe('no-baseline');
    await recordCurrentBaseline(world, file);
    expect(await world.ledger.compare(file)).toBe('clean');
    expect(world.fake.watchCalls).toEqual([]);
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

    expect(await world.ledger.compare(file)).toBe('stale');
    expect(world.statCalls()).toBeGreaterThan(0);
  });
});
