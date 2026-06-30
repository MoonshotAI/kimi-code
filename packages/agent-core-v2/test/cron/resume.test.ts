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
import type { ContextMessage, PromptOrigin } from '#/index';
import { IPromptService } from '#/index';
import { ICronService } from '#/cron';
import { createCronPersistStore } from '#/cron/tools/persist';
import type { ClockSources } from '#/cron/tools/clock';
import { createTestAgent, cronServices, type TestAgentContext } from '../harness';

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

function captureSteer(prompt: IPromptService): SteerCall[] {
  const calls: SteerCall[] = [];
  prompt.steer = (message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return undefined;
  };
  return calls;
}

async function readDiskIds(sessionDir: string): Promise<readonly string[]> {
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
  let sessionDir: string;
  let ctx: TestAgentContext;
  let cron: ICronService;
  let prompt: IPromptService;
  let resumedCtx: TestAgentContext | undefined;
  let resumedCron: ICronService | undefined;
  let resumedPrompt: IPromptService | undefined;

  beforeEach(async () => {
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-cron-resume-'));
    resumedCtx = undefined;
    resumedCron = undefined;
    resumedPrompt = undefined;
  });

  afterEach(async () => {
    try {
      if (resumedCtx !== undefined) {
        await resumedCtx.expectResumeMatches();
      }
      await ctx.expectResumeMatches();
    } finally {
      try {
        await resumedCtx?.dispose();
      } finally {
        try {
          await ctx.dispose();
        } finally {
          vi.unstubAllEnvs();
          await rm(sessionDir, { recursive: true, force: true });
        }
      }
    }
  });

  describe('single session persistence', () => {
    let harness: ClockHarness;

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: harness.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
    });

    it('addTask writes a JSON record to <sessionDir>/cron/<id>.json', async () => {
      const task = cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'ping',
      });
      await cron.flushPersist();

      const store = createCronPersistStore(sessionDir);
      const loaded = await store.read(task.id);
      expect(loaded).toEqual({
        id: task.id,
        cron: '*/5 * * * *',
        prompt: 'ping',
        createdAt: harness.now(),
        recurring: undefined,
      });
      expect(await readDiskIds(sessionDir)).toEqual([task.id]);
    });

    it('removeTasks deletes the JSON record', async () => {
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      await cron.flushPersist();
      expect((await readDiskIds(sessionDir)).length).toBe(1);

      cron.removeTasks([task.id]);
      await cron.flushPersist();
      expect(await readDiskIds(sessionDir)).toEqual([]);
    });
  });

  describe('loadFromDisk', () => {
    let clockA: ClockHarness;
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      clockB = createClocks(clockA.now() + 60_000);
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockA.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
      resumedCtx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockB.clocks,
          pollIntervalMs: null,
        }),
      );
      resumedCron = resumedCtx.get(ICronService);
    });

    it('re-adopts tasks with original id and createdAt', async () => {
      const t1 = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      const t2 = cron.addTask({
        cron: '0 9 * * *',
        prompt: 'b',
        recurring: true,
      });
      await cron.flushPersist();

      expect(resumedCron!.store.list()).toEqual([]);
      await resumedCron!.loadFromDisk();

      const loaded = resumedCron!.store.list().slice().toSorted((a, b) => a.id.localeCompare(b.id));
      const expected = [t1, t2].toSorted((a, b) => a.id.localeCompare(b.id));
      expect(loaded.map((t) => t.id)).toEqual(expected.map((t) => t.id));
      for (const original of expected) {
        const reloaded = resumedCron!.getTask(original.id);
        expect(reloaded).toBeDefined();
        expect(reloaded?.cron).toBe(original.cron);
        expect(reloaded?.prompt).toBe(original.prompt);
        expect(reloaded?.createdAt).toBe(original.createdAt);
      }
    });
  });

  describe('recurring resume fire', () => {
    let clockA: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      const clockB = createClocks(clockA.now() + 23 * 60_000);
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockA.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
      resumedCtx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockB.clocks,
          pollIntervalMs: null,
        }),
      );
      resumedCron = resumedCtx.get(ICronService);
      resumedPrompt = resumedCtx.get(IPromptService);
    });

    it('recurring task missed during downtime fires once with coalescedCount > 1', async () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();
      await resumedCron!.loadFromDisk();

      const steerCalls = captureSteer(resumedPrompt!);
      resumedCron!.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.coalescedCount).toBeGreaterThan(1);
      expect(origin.stale).toBe(false);
      expect(origin.recurring).toBe(true);
    });
  });

  describe('one-shot resume fire', () => {
    let clockA: ClockHarness;

    beforeEach(() => {
      clockA = createClocks(WALL_ANCHOR);
      const clockB = createClocks(clockA.now() + 10 * 60_000);
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockA.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
      resumedCtx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockB.clocks,
          pollIntervalMs: null,
        }),
      );
      resumedCron = resumedCtx.get(ICronService);
      resumedPrompt = resumedCtx.get(IPromptService);
    });

    it('one-shot scheduled in the past fires once on resume and the file is removed', async () => {
      const oneShot = cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'remind once',
        recurring: false,
      });
      await cron.flushPersist();
      expect(await readDiskIds(sessionDir)).toEqual([oneShot.id]);
      await resumedCron!.loadFromDisk();

      const steerCalls = captureSteer(resumedPrompt!);
      resumedCron!.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.recurring).toBe(false);
      expect(origin.coalescedCount).toBe(1);

      await resumedCron!.flushPersist();
      expect(resumedCron!.store.list()).toEqual([]);
      expect(await readDiskIds(sessionDir)).toEqual([]);
    });
  });

  describe('recurring task already fired before shutdown', () => {
    let clockA: ClockHarness;

    beforeEach(() => {
      clockA = createClocks(WALL_ANCHOR);
      const clockB = createClocks(WALL_ANCHOR + 23 * 60_000);
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockA.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      resumedCtx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockB.clocks,
          pollIntervalMs: null,
        }),
      );
      resumedCron = resumedCtx.get(ICronService);
      resumedPrompt = resumedCtx.get(IPromptService);
    });

    it('does NOT replay on resume', async () => {
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();

      const steerCallsA = captureSteer(prompt);
      clockA.advance(6 * 60_000);
      cron.tick();
      expect(steerCallsA.length).toBe(1);

      await cron.flushPersist();

      const onDisk = await createCronPersistStore(sessionDir).read(task.id);
      expect(typeof onDisk?.lastFiredAt).toBe('number');
      expect(onDisk!.lastFiredAt!).toBeLessThanOrEqual(clockA.now());

      await resumedCron!.loadFromDisk();

      const steerCallsB = captureSteer(resumedPrompt!);
      resumedCron!.tick();

      expect(steerCallsB.length).toBe(1);
      const resumeOrigin = steerCallsB[0]!.origin;
      if (resumeOrigin.kind !== 'cron_job') throw new Error('unreachable');
      expect(resumeOrigin.coalescedCount).toBeLessThanOrEqual(4);
      expect(resumeOrigin.coalescedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('corrupt lastFiredAt', () => {
    let clockA: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      const clockB = createClocks(clockA.now() + 23 * 60_000);
      ctx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockA.clocks,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
      resumedCtx = createTestAgent(
        cronServices({
          homedir: sessionDir,
          autoStart: false,
          clocks: clockB.clocks,
          pollIntervalMs: null,
        }),
      );
      resumedCron = resumedCtx.get(ICronService);
      resumedPrompt = resumedCtx.get(IPromptService);
    });

    it('treats a future lastFiredAt as corrupt and falls back to createdAt', async () => {
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();

      const store = createCronPersistStore(sessionDir);
      const original = await store.read(task.id);
      if (original === undefined) throw new Error('expected persisted task');
      await store.write(task.id, {
        ...original,
        lastFiredAt: clockA.now() + 365 * 24 * 60 * 60 * 1000,
      });

      await resumedCron!.loadFromDisk();

      const steerCalls = captureSteer(resumedPrompt!);
      resumedCron!.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.coalescedCount).toBeGreaterThan(1);
    });
  });

  describe('in-memory mode', () => {
    beforeEach(() => {
      const harness = createClocks();
      ctx = createTestAgent(
        cronServices({ autoStart: false, clocks: harness.clocks, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
    });

    it('no sessionDir = pure in-memory: no FS side effects, loadFromDisk is a no-op', async () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      await cron.flushPersist();
      expect(await readDiskIds(sessionDir)).toEqual([]);

      expect(cron.store.list().length).toBe(1);
      await cron.loadFromDisk();
      expect(cron.store.list().length).toBe(1);
    });
  });
});
