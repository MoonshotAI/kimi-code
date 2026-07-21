/**
 * `sessionFileLedger` domain (L2) — verifies the optimistic-concurrency
 * verdicts (clean / stale / no-baseline) against a real tmpdir and a real
 * `HostFileSystem` with stat calls counted. Baselines are compared only
 * against fresh stat tuples, and stat failures fail closed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionFileLedger } from '#/session/sessionFileLedger/fileLedger';
import { SessionFileLedger } from '#/session/sessionFileLedger/fileLedgerService';

import { countingHostFs } from '../sessionFs/stubs';

void SessionFileLedger;

interface World {
  readonly workDir: string;
  readonly fs: IHostFileSystem;
  readonly ledger: ISessionFileLedger;
  readonly statCalls: () => number;
  readonly poisonedPaths: Set<string>;
}

function makeWorld(): World {
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-ledger-work-'));
  cleanupPaths.push(workDir);
  const poisonedPaths = new Set<string>();
  const { fs, statCalls } = countingHostFs(poisonedPaths);
  const host = createScopedTestHost([stubPair(IHostFileSystem, fs)]);
  const session = host.child(LifecycleScope.Session, 's1');
  hosts.push(host);
  return {
    workDir,
    fs,
    ledger: session.accessor.get(ISessionFileLedger),
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

  it('returns clean for a missing file (new-file creation is exempt)', async () => {
    const world = makeWorld();
    expect(await world.ledger.compare(join(world.workDir, 'new.txt'))).toBe('clean');
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

  it('fails closed when stat fails for reasons other than not-found', async () => {
    const world = makeWorld();
    const file = join(world.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await recordCurrentBaseline(world, file);
    world.poisonedPaths.add(file);

    expect(await world.ledger.compare(file)).toBe('stale');
    expect(world.statCalls()).toBeGreaterThan(0);
  });
});
