/**
 * Resume / cross-restart persistence for CronManager.
 *
 * The manager's `addTask` / `removeTasks` wrappers mirror every mutation
 * to `<sessionDir>/cron/<id>.json`, and `loadFromDisk()` re-populates
 * the in-memory store on `kimi resume`. The scheduler's
 * `createdAt`-based baseline is what makes a reloaded task fire
 * correctly even when ideal fire times landed during downtime — these
 * tests pin down both sides of the contract.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import { createCronPersistStore } from '../../../src/tools/cron/persist';
import {
  createAgentStub,
  createClocks,
  WALL_ANCHOR,
} from './harness/stub';

let sessionDir: string;

beforeEach(async () => {
  // Disable jitter so the scheduler delivers on exact ideal fires.
  vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  sessionDir = await mkdtemp(join(tmpdir(), 'kimi-cron-resume-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sessionDir, { recursive: true, force: true });
});

async function readDiskIds(): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(sessionDir, 'cron'));
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .toSorted();
  } catch {
    return [];
  }
}

describe('CronManager — persistence and resume', () => {
  it('addTask writes a JSON record to <sessionDir>/cron/<id>.json', async () => {
    const { agent } = createAgentStub();
    const harness = createClocks();
    const manager = new CronManager(agent, {
      clocks: harness.clocks,
      pollIntervalMs: null,
      sessionDir,
    });

    const task = manager.addTask({
      cron: '*/5 * * * *',
      prompt: 'ping',
    });
    await manager.flushPersist();

    const store = createCronPersistStore(sessionDir);
    const loaded = await store.read(task.id);
    expect(loaded).toEqual({
      id: task.id,
      cron: '*/5 * * * *',
      prompt: 'ping',
      createdAt: harness.now(),
      // `recurring` defaults to recurring; the store omits it iff the
      // caller did. We pass through `init` as-is, so an unset field
      // round-trips as undefined.
      recurring: undefined,
    });
    expect(await readDiskIds()).toEqual([task.id]);

    await manager.stop();
  });

  it('removeTasks deletes the JSON record', async () => {
    const { agent } = createAgentStub();
    const harness = createClocks();
    const manager = new CronManager(agent, {
      clocks: harness.clocks,
      pollIntervalMs: null,
      sessionDir,
    });

    const task = manager.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    await manager.flushPersist();
    expect((await readDiskIds()).length).toBe(1);

    manager.removeTasks([task.id]);
    await manager.flushPersist();
    expect(await readDiskIds()).toEqual([]);

    await manager.stop();
  });

  it('loadFromDisk re-adopts tasks with original id and createdAt', async () => {
    // First "session": schedule two recurring tasks.
    const stubA = createAgentStub();
    const clockA = createClocks();
    const managerA = new CronManager(stubA.agent, {
      clocks: clockA.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    const t1 = managerA.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    const t2 = managerA.addTask({
      cron: '0 9 * * *',
      prompt: 'b',
      recurring: true,
    });
    await managerA.flushPersist();
    await managerA.stop();

    // Second "session": fresh manager, same sessionDir.
    const stubB = createAgentStub();
    const clockB = createClocks(clockA.now() + 60_000);
    const managerB = new CronManager(stubB.agent, {
      clocks: clockB.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    expect(managerB.store.list()).toEqual([]);
    await managerB.loadFromDisk();

    const loaded = managerB.store.list().slice().toSorted((a, b) => a.id.localeCompare(b.id));
    const expected = [t1, t2].toSorted((a, b) => a.id.localeCompare(b.id));
    expect(loaded.map((t) => t.id)).toEqual(expected.map((t) => t.id));
    for (const original of expected) {
      const reloaded = managerB.store.get(original.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.cron).toBe(original.cron);
      expect(reloaded?.prompt).toBe(original.prompt);
      expect(reloaded?.createdAt).toBe(original.createdAt);
    }

    await managerB.stop();
  });

  it('recurring task missed during downtime fires once with coalescedCount > 1', async () => {
    // Session A: create a `*/5 * * * *` task.
    const stubA = createAgentStub();
    const clockA = createClocks();
    const managerA = new CronManager(stubA.agent, {
      clocks: clockA.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    managerA.addTask({ cron: '*/5 * * * *', prompt: 'check' });
    await managerA.flushPersist();
    await managerA.stop();

    // Session B: 23 minutes later (≈ 4 ideal fires missed: t+5, +10,
    // +15, +20). With createdAt as the baseline the scheduler must
    // collapse them into one fire.
    const stubB = createAgentStub();
    const clockB = createClocks(clockA.now() + 23 * 60_000);
    const managerB = new CronManager(stubB.agent, {
      clocks: clockB.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    await managerB.loadFromDisk();
    managerB.tick();

    expect(stubB.steerCalls.length).toBe(1);
    const origin = stubB.steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.coalescedCount).toBeGreaterThan(1);
    expect(origin.stale).toBe(false); // < 7 days old
    expect(origin.recurring).toBe(true);

    await managerB.stop();
  });

  it('one-shot scheduled in the past fires once on resume and the file is removed', async () => {
    // Session A: schedule a one-shot 5 minutes ahead of clockA's now,
    // then quit before it fires.
    const stubA = createAgentStub();
    const clockA = createClocks(WALL_ANCHOR);
    const managerA = new CronManager(stubA.agent, {
      clocks: clockA.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    // Compute a cron expression that lands 5 minutes in the future
    // using the harness's anchor (Nov 14 2023 22:13:20 UTC). The next
    // `*/5 * * * *` ideal after the anchor is 22:15:00 UTC.
    const oneShot = managerA.addTask({
      cron: '*/5 * * * *',
      prompt: 'remind once',
      recurring: false,
    });
    await managerA.flushPersist();
    expect(await readDiskIds()).toEqual([oneShot.id]);
    await managerA.stop();

    // Session B: 10 minutes after the anchor — the one-shot's ideal
    // fire (anchor + 100s ≈ 22:15:00) is in the past.
    const stubB = createAgentStub();
    const clockB = createClocks(clockA.now() + 10 * 60_000);
    const managerB = new CronManager(stubB.agent, {
      clocks: clockB.clocks,
      pollIntervalMs: null,
      sessionDir,
    });
    await managerB.loadFromDisk();
    managerB.tick();

    expect(stubB.steerCalls.length).toBe(1);
    const origin = stubB.steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.recurring).toBe(false);
    // One-shots always report coalescedCount = 1 regardless of how
    // long ago they should have fired (their semantics are "remind
    // me once", not "remind me N times").
    expect(origin.coalescedCount).toBe(1);

    // After firing, the scheduler asks the manager to remove the
    // one-shot, which clears both in-memory and on-disk records.
    await managerB.flushPersist();
    expect(managerB.store.list()).toEqual([]);
    expect(await readDiskIds()).toEqual([]);

    await managerB.stop();
  });

  it('no sessionDir = pure in-memory: no FS side effects, loadFromDisk is a no-op', async () => {
    const { agent } = createAgentStub();
    const harness = createClocks();
    // Construct without sessionDir.
    const manager = new CronManager(agent, {
      clocks: harness.clocks,
      pollIntervalMs: null,
    });

    manager.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    await manager.flushPersist();
    expect(await readDiskIds()).toEqual([]); // sessionDir untouched

    // loadFromDisk must not pollute the existing in-memory list.
    expect(manager.store.list().length).toBe(1);
    await manager.loadFromDisk();
    expect(manager.store.list().length).toBe(1);

    await manager.stop();
  });
});
