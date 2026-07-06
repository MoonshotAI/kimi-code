/**
 * Resume / cross-restart persistence for SessionCronService.
 *
 * The manager's `addTask` / `removeTasks` wrappers mirror every mutation
 * to `<sessionDir>/agents/<agentId>/cron/<id>.json`, and `loadFromStore()`
 * re-populates the in-memory store on `kimi resume`. The scheduler's
 * `createdAt`-based baseline is what makes a reloaded task fire
 * correctly even when ideal fire times landed during downtime — these
 * tests pin down both sides of the contract.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentPart } from '#/app/llmProtocol';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';
import { IAgentPromptService } from '#/agent/prompt';
import type { CronTask } from '#/app/cron';
import { ISessionCronService } from '#/session/cron';
import { IBootstrapService } from '#/app/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext';
import {
  createTestAgent,
  cronServices,
  homeDirServices,
  type TestAgentContext,
} from '../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface ClockHarness {
  install(): void;
  setNow(v: number): void;
  advance(ms: number): void;
  now(): number;
}

function createClocks(initial: number = WALL_ANCHOR): ClockHarness {
  let wall = initial;
  return {
    install: () => {
      vi.spyOn(Date, 'now').mockImplementation(() => wall);
    },
    setNow: (v) => {
      wall = v;
    },
    advance: (ms) => {
      wall += ms;
    },
    now: () => wall,
  };
}

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

function captureSteer(prompt: IAgentPromptService): SteerCall[] {
  const calls: SteerCall[] = [];
  prompt.steer = (message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return {
      removeFromQueue: () => {},
      launched: Promise.resolve(undefined),
    };
  };
  return calls;
}

function cronDir(ctx: TestAgentContext): string {
  const session = ctx.get(ISessionContext);
  return join(session.sessionDir, 'agents', 'main', 'cron');
}

function cronScope(ctx: TestAgentContext): string {
  const bootstrap = ctx.get(IBootstrapService);
  return relative(bootstrap.homeDir, cronDir(ctx));
}

async function readDiskIds(ctx: TestAgentContext): Promise<readonly string[]> {
  try {
    const entries = await readdir(cronDir(ctx));
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .toSorted();
  } catch {
    return [];
  }
}

function createCronAgent(
  sessionDir: string,
  cronOverride: ReturnType<typeof cronServices>,
): TestAgentContext {
  return createTestAgent(homeDirServices(sessionDir), cronOverride);
}

function cronDocuments(ctx: TestAgentContext): IAtomicDocumentStore {
  return ctx.get(IAtomicDocumentStore);
}

async function readPersistedTask(
  ctx: TestAgentContext,
  id: string,
): Promise<CronTask | undefined> {
  return cronDocuments(ctx).get<CronTask>(cronScope(ctx), `${id}.json`);
}

describe('SessionCronService — persistence and resume', () => {
  let sessionDir: string;
  let ctx: TestAgentContext;
  let cron: ISessionCronService;
  let prompt: IAgentPromptService;
  let resumedCtx: TestAgentContext | undefined;
  let resumedCron: ISessionCronService | undefined;
  let resumedPrompt: IAgentPromptService | undefined;

  beforeEach(async () => {
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
    vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '0');
    sessionDir = await mkdtemp(join(tmpdir(), 'kimi-cron-resume-'));
    resumedCtx = undefined;
    resumedCron = undefined;
    resumedPrompt = undefined;
  });

  afterEach(async () => {
    try {
      await resumedCtx?.dispose();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await rm(sessionDir, { recursive: true, force: true });
      }
    }
  });

  describe('single session persistence', () => {
    let harness: ClockHarness;

    beforeEach(() => {
      harness = createClocks();
      harness.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
    });

    it('addTask writes a JSON record to <sessionDir>/agents/<agentId>/cron/<id>.json', async () => {
      const task = cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'ping',
      });
      await cron.flushPersist();

      const loaded = await readPersistedTask(ctx, task.id);
      expect(loaded).toEqual({
        id: task.id,
        cron: '*/5 * * * *',
        prompt: 'ping',
        createdAt: harness.now(),
        recurring: undefined,
      });
      expect(await readDiskIds(ctx)).toEqual([task.id]);
    });

    it('removeTasks deletes the JSON record', async () => {
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      await cron.flushPersist();
      expect((await readDiskIds(ctx)).length).toBe(1);

      cron.removeTasks([task.id]);
      await cron.flushPersist();
      expect(await readDiskIds(ctx)).toEqual([]);
    });
  });

  describe('loadFromStore', () => {
    let clockA: ClockHarness;
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      clockB = createClocks(clockA.now() + 60_000);
      clockA.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
      clockB.install();
      resumedCtx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      resumedCron = resumedCtx.get(ISessionCronService);
    });

    it('re-adopts tasks with original id and createdAt', async () => {
      clockA.install();
      const t1 = cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      const t2 = cron.addTask({
        cron: '0 9 * * *',
        prompt: 'b',
        recurring: true,
      });
      await cron.flushPersist();

      expect(resumedCron!.list()).toEqual([]);
      clockB.install();
      await resumedCron!.loadFromStore();

      const loaded = resumedCron!.list().slice().toSorted((a, b) => a.id.localeCompare(b.id));
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
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      clockB = createClocks(clockA.now() + 23 * 60_000);
      clockA.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
      clockB.install();
      resumedCtx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      resumedCron = resumedCtx.get(ISessionCronService);
      resumedPrompt = resumedCtx.get(IAgentPromptService);
    });

    it('recurring task missed during downtime fires once with coalescedCount > 1', async () => {
      clockA.install();
      cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();
      clockB.install();
      await resumedCron!.loadFromStore();

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
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks(WALL_ANCHOR);
      clockB = createClocks(clockA.now() + 10 * 60_000);
      clockA.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
      clockB.install();
      resumedCtx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      resumedCron = resumedCtx.get(ISessionCronService);
      resumedPrompt = resumedCtx.get(IAgentPromptService);
    });

    it('one-shot scheduled in the past fires once on resume and the file is removed', async () => {
      clockA.install();
      const oneShot = cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'remind once',
        recurring: false,
      });
      await cron.flushPersist();
      expect(await readDiskIds(ctx)).toEqual([oneShot.id]);
      clockB.install();
      await resumedCron!.loadFromStore();

      const steerCalls = captureSteer(resumedPrompt!);
      resumedCron!.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.recurring).toBe(false);
      expect(origin.coalescedCount).toBe(1);

      await resumedCron!.flushPersist();
      expect(resumedCron!.list()).toEqual([]);
      expect(await readDiskIds(ctx)).toEqual([]);
    });
  });

  describe('recurring task already fired before shutdown', () => {
    let clockA: ClockHarness;
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks(WALL_ANCHOR);
      clockB = createClocks(WALL_ANCHOR + 23 * 60_000);
      clockA.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
      prompt = ctx.get(IAgentPromptService);
      clockB.install();
      resumedCtx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      resumedCron = resumedCtx.get(ISessionCronService);
      resumedPrompt = resumedCtx.get(IAgentPromptService);
    });

    it('does NOT replay on resume', async () => {
      clockA.install();
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();

      const steerCallsA = captureSteer(prompt);
      clockA.advance(6 * 60_000);
      cron.tick();
      expect(steerCallsA.length).toBe(1);

      await cron.flushPersist();

      const onDisk = await readPersistedTask(ctx, task.id);
      expect(typeof onDisk?.lastFiredAt).toBe('number');
      expect(onDisk!.lastFiredAt!).toBeLessThanOrEqual(clockA.now());

      clockB.install();
      await resumedCron!.loadFromStore();

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
    let clockB: ClockHarness;

    beforeEach(() => {
      clockA = createClocks();
      clockB = createClocks(clockA.now() + 23 * 60_000);
      clockA.install();
      ctx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
      clockB.install();
      resumedCtx = createCronAgent(
        sessionDir,
        cronServices(),
      );
      resumedCron = resumedCtx.get(ISessionCronService);
      resumedPrompt = resumedCtx.get(IAgentPromptService);
    });

    it('treats a future lastFiredAt as corrupt and falls back to createdAt', async () => {
      clockA.install();
      const task = cron.addTask({ cron: '*/5 * * * *', prompt: 'check' });
      await cron.flushPersist();

      const original = await readPersistedTask(ctx, task.id);
      if (original === undefined) throw new Error('expected persisted task');
      await cronDocuments(ctx).set(cronScope(ctx), `${task.id}.json`, {
        ...original,
        lastFiredAt: clockA.now() + 365 * 24 * 60 * 60 * 1000,
      });

      clockB.install();
      await resumedCron!.loadFromStore();

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
      harness.install();
      ctx = createTestAgent(
        cronServices(),
      );
      cron = ctx.get(ISessionCronService);
    });

    it('no sessionDir = pure in-memory: no FS side effects, loadFromStore is a no-op', async () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'a' });
      await cron.flushPersist();
      expect(await readDiskIds(ctx)).toEqual([]);

      expect(cron.list().length).toBe(1);
      await cron.loadFromStore();
      expect(cron.list().length).toBe(1);
    });
  });
});
