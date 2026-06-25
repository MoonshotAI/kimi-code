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

import type { ContentPart } from '@moonshot-ai/kosong';
import type { ContextMessage, PromptOrigin } from '../../../../src/services/agent';
import { IPromptService } from '../../../../src/services/agent';
import { createCronPersistStore } from '../../../../src/tools/cron/persist';
import type { ClockSources } from '../../../../src/tools/cron/clock';
import { testAgent, type TestAgentContext } from '../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface ClockHarness {
  readonly clocks: ClockSources;
  setNow(v: number): void;
  advance(ms: number): void;
  now(): number;
}

function createClocks(initial: number = WALL_ANCHOR): ClockHarness {
  let wall = initial;
  let mono = 1_000_000;
  return {
    clocks: {
      wallNow: () => wall,
      monoNowMs: () => mono,
    },
    setNow: (v) => {
      wall = v;
      mono = v;
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
  };
}

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

function captureSteer(ctx: TestAgentContext): SteerCall[] {
  const calls: SteerCall[] = [];
  const prompt = ctx.get(IPromptService);
  prompt.steer = (message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return undefined;
  };
  return calls;
}

let sessionDir: string;

beforeEach(async () => {
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
    const harness = createClocks();
    const ctx = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: harness.clocks, pollIntervalMs: null },
    });

    const task = ctx.cron.addTask({
      cron: '*/5 * * * *',
      prompt: 'ping',
    });
    await ctx.cron.flushPersist();

    const store = createCronPersistStore(sessionDir);
    const loaded = await store.read(task.id);
    expect(loaded).toEqual({
      id: task.id,
      cron: '*/5 * * * *',
      prompt: 'ping',
      createdAt: harness.now(),
      recurring: undefined,
    });
    expect(await readDiskIds()).toEqual([task.id]);

    await ctx.cron.stop();
  });

  it('removeTasks deletes the JSON record', async () => {
    const harness = createClocks();
    const ctx = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: harness.clocks, pollIntervalMs: null },
    });

    const task = ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    await ctx.cron.flushPersist();
    expect((await readDiskIds()).length).toBe(1);

    ctx.cron.removeTasks([task.id]);
    await ctx.cron.flushPersist();
    expect(await readDiskIds()).toEqual([]);

    await ctx.cron.stop();
  });

  it('loadFromDisk re-adopts tasks with original id and createdAt', async () => {
    const clockA = createClocks();
    const ctxA = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockA.clocks, pollIntervalMs: null },
    });
    const t1 = ctxA.cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    const t2 = ctxA.cron.addTask({
      cron: '0 9 * * *',
      prompt: 'b',
      recurring: true,
    });
    await ctxA.cron.flushPersist();
    await ctxA.cron.stop();

    const clockB = createClocks(clockA.now() + 60_000);
    const ctxB = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockB.clocks, pollIntervalMs: null },
    });
    expect(ctxB.cron.store.list()).toEqual([]);
    await ctxB.cron.loadFromDisk();

    const loaded = ctxB.cron.store.list().slice().toSorted((a, b) => a.id.localeCompare(b.id));
    const expected = [t1, t2].toSorted((a, b) => a.id.localeCompare(b.id));
    expect(loaded.map((t) => t.id)).toEqual(expected.map((t) => t.id));
    for (const original of expected) {
      const reloaded = ctxB.cron.getTask(original.id);
      expect(reloaded).toBeDefined();
      expect(reloaded?.cron).toBe(original.cron);
      expect(reloaded?.prompt).toBe(original.prompt);
      expect(reloaded?.createdAt).toBe(original.createdAt);
    }

    await ctxB.cron.stop();
  });

  it('recurring task missed during downtime fires once with coalescedCount > 1', async () => {
    const clockA = createClocks();
    const ctxA = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockA.clocks, pollIntervalMs: null },
    });
    ctxA.cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
    await ctxA.cron.flushPersist();
    await ctxA.cron.stop();

    const clockB = createClocks(clockA.now() + 23 * 60_000);
    const ctxB = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockB.clocks, pollIntervalMs: null },
    });
    await ctxB.cron.loadFromDisk();

    const steerCalls = captureSteer(ctxB);
    ctxB.cron.tick();

    expect(steerCalls.length).toBe(1);
    const origin = steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.coalescedCount).toBeGreaterThan(1);
    expect(origin.stale).toBe(false);
    expect(origin.recurring).toBe(true);

    await ctxB.cron.stop();
  });

  it('one-shot scheduled in the past fires once on resume and the file is removed', async () => {
    const clockA = createClocks(WALL_ANCHOR);
    const ctxA = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockA.clocks, pollIntervalMs: null },
    });
    const oneShot = ctxA.cron.addTask({
      cron: '*/5 * * * *',
      prompt: 'remind once',
      recurring: false,
    });
    await ctxA.cron.flushPersist();
    expect(await readDiskIds()).toEqual([oneShot.id]);
    await ctxA.cron.stop();

    const clockB = createClocks(clockA.now() + 10 * 60_000);
    const ctxB = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockB.clocks, pollIntervalMs: null },
    });
    await ctxB.cron.loadFromDisk();

    const steerCalls = captureSteer(ctxB);
    ctxB.cron.tick();

    expect(steerCalls.length).toBe(1);
    const origin = steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.recurring).toBe(false);
    expect(origin.coalescedCount).toBe(1);

    await ctxB.cron.flushPersist();
    expect(ctxB.cron.store.list()).toEqual([]);
    expect(await readDiskIds()).toEqual([]);

    await ctxB.cron.stop();
  });

  it('recurring task fired before shutdown does NOT replay on resume', async () => {
    const clockA = createClocks(WALL_ANCHOR);
    const ctxA = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockA.clocks, pollIntervalMs: null },
    });
    const task = ctxA.cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
    await ctxA.cron.flushPersist();

    const steerCallsA = captureSteer(ctxA);
    clockA.advance(6 * 60_000);
    ctxA.cron.tick();
    expect(steerCallsA.length).toBe(1);

    await ctxA.cron.flushPersist();
    await ctxA.cron.stop();

    const onDisk = await createCronPersistStore(sessionDir).read(task.id);
    expect(typeof onDisk?.lastFiredAt).toBe('number');
    expect(onDisk!.lastFiredAt!).toBeLessThanOrEqual(clockA.now());

    const clockB = createClocks(WALL_ANCHOR + 23 * 60_000);
    const ctxB = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockB.clocks, pollIntervalMs: null },
    });
    await ctxB.cron.loadFromDisk();

    const steerCallsB = captureSteer(ctxB);
    ctxB.cron.tick();

    expect(steerCallsB.length).toBe(1);
    const resumeOrigin = steerCallsB[0]!.origin;
    if (resumeOrigin.kind !== 'cron_job') throw new Error('unreachable');
    expect(resumeOrigin.coalescedCount).toBeLessThanOrEqual(4);
    expect(resumeOrigin.coalescedCount).toBeGreaterThanOrEqual(1);

    await ctxB.cron.stop();
  });

  it('treats a future lastFiredAt as corrupt and falls back to createdAt', async () => {
    const clockA = createClocks();
    const ctxA = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockA.clocks, pollIntervalMs: null },
    });
    const task = ctxA.cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
    await ctxA.cron.flushPersist();
    await ctxA.cron.stop();

    const store = createCronPersistStore(sessionDir);
    const original = await store.read(task.id);
    if (original === undefined) throw new Error('expected persisted task');
    await store.write(task.id, {
      ...original,
      lastFiredAt: clockA.now() + 365 * 24 * 60 * 60 * 1000,
    });

    const clockB = createClocks(clockA.now() + 23 * 60_000);
    const ctxB = testAgent({
      homedir: sessionDir,
      cron: { autoStart: false, clocks: clockB.clocks, pollIntervalMs: null },
    });
    await ctxB.cron.loadFromDisk();

    const steerCalls = captureSteer(ctxB);
    ctxB.cron.tick();

    expect(steerCalls.length).toBe(1);
    const origin = steerCalls[0]!.origin;
    if (origin.kind !== 'cron_job') throw new Error('unreachable');
    expect(origin.coalescedCount).toBeGreaterThan(1);

    await ctxB.cron.stop();
  });

  it('no sessionDir = pure in-memory: no FS side effects, loadFromDisk is a no-op', async () => {
    const harness = createClocks();
    const ctx = testAgent({
      cron: { autoStart: false, clocks: harness.clocks, pollIntervalMs: null },
    });

    ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
    await ctx.cron.flushPersist();
    expect(await readDiskIds()).toEqual([]);

    expect(ctx.cron.store.list().length).toBe(1);
    await ctx.cron.loadFromDisk();
    expect(ctx.cron.store.list().length).toBe(1);

    await ctx.cron.stop();
  });
});
