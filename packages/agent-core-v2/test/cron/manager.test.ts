/**
 * Tests for `agent/cron/manager.ts`. Uses a lightweight Agent stub
 * (see ./harness/stub) — only the three surfaces the manager touches
 * (turn.hasActiveTurn, turn.steer, telemetry.track) need to look real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentPart } from '@moonshot-ai/kosong';

import {
  CRON_FIRED,
  CRON_MISSED,
} from '#/cron/tools/telemetry-events';
import type { CronTask } from '#/cron/tools/types';
import { ICronService } from '#/cron';
import { IPromptService } from '#/prompt';
import type { ContextMessage, PromptOrigin } from '#/contextMemory';
import { ITelemetryService } from '#/telemetry';
import { ITurnService, type Turn } from '#/turn';
import { createTestAgent, cronServices, type TestAgentContext } from '../harness';
import type { TelemetryRecord } from '../telemetry/stubs';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stable wall-clock anchor (Nov 14 2023, 22:13:20 UTC). Deliberately
 * off any round minute so the next `*\/5 * * * *` ideal fire is not
 * exactly five minutes ahead, exercising the strict-greater-than
 * branch of `computeNextCronRun`.
 */
const WALL_ANCHOR = 1_700_000_000_000;

function createClocks(initial = WALL_ANCHOR) {
  let wall = initial;
  let mono = 1_000_000;
  return {
    clocks: {
      wallNow: () => wall,
      monoNowMs: () => mono,
    },
    setNow(v: number) {
      wall = v;
      mono = v;
    },
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    now() {
      return wall;
    },
  };
}

function createSteerSpy(
  prompt: IPromptService,
  ...args: [
    returnValue?: Turn | undefined,
  ]
) {
  const returnValue = args.length === 0 ? {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' as const }),
  } : args[0];
  const calls: Array<{ content: readonly ContentPart[]; origin: PromptOrigin }> = [];
  vi.spyOn(prompt, 'steer').mockImplementation((message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return returnValue;
  });
  return calls;
}

function captureTelemetry(telemetry: ITelemetryService): TelemetryRecord[] {
  const records: TelemetryRecord[] = [];
  vi.spyOn(telemetry, 'track').mockImplementation(
    (event, properties) => {
      records.push({ event, properties });
    },
  );
  return records;
}

describe('CronManager', () => {
  let cron: ICronService;
  let ctx: TestAgentContext;
  let prompt: IPromptService;
  let telemetry: ITelemetryService;
  let turn: ITurnService;

  beforeEach(() => {
    // Pin jitter off so fire-count assertions are deterministic. Each
    // test that actually exercises fires resets the env via stubEnv,
    // but setting it here as well shields the construction-path tests
    // from any leaked state.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  describe('construction', () => {
    beforeEach(() => {
      ctx = createTestAgent(cronServices({ autoStart: false, pollIntervalMs: null }));
      cron = ctx.get(ICronService);
    });

    it('does not throw with default clocks and supports start/stop', async () => {
      // Disable the auto-tick timer so the test doesn't have to wait
      // for setInterval / clean it up; we just want start() and stop()
      // to be wired and idempotent.
      expect(() => cron.start()).not.toThrow();
      expect(() => cron.start()).not.toThrow(); // idempotent
      await expect(cron.stop()).resolves.toBeUndefined();
      await expect(cron.stop()).resolves.toBeUndefined();
    });

    it('exposes the session store as an empty list on construction', () => {
      expect(cron.store.list()).toEqual([]);
      expect(cron.getNextFireTime()).toBeNull();
    });

    it('getNextFireForTask delegates to the scheduler', () => {
      const spy = vi.spyOn(cron, 'getNextFireForTask').mockReturnValue(123);
      expect(cron.getNextFireForTask('deadbeef')).toBe(123);
      expect(spy).toHaveBeenCalledWith('deadbeef');
    });
  });

  describe('handleFire — recurring', () => {
    let harness: ReturnType<typeof createClocks>;
    let steerCalls: ReturnType<typeof createSteerSpy>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      telemetryRecords = captureTelemetry(telemetry);
      steerCalls = createSteerSpy(prompt, {
        id: 7,
        abortController: new AbortController(),
        ready: Promise.resolve(),
        result: Promise.resolve({ reason: 'completed' as const }),
      });
    });

    it('steers with cron_job origin and emits cron_fired telemetry', () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'check the deploy' });
      // `*/5 * * * *` lands every 5 minutes; bump 6 minutes so we are
      // safely past exactly one ideal fire.
      harness.advance(6 * 60_000);
      cron.tick();

      expect(steerCalls.length).toBe(1);
      const call = steerCalls[0]!;
      expect(call.origin.kind).toBe('cron_job');
      if (call.origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(call.origin.recurring).toBe(true);
      expect(call.origin.stale).toBe(false);
      expect(call.origin.coalescedCount).toBeGreaterThanOrEqual(1);
      expect(call.origin.cron).toBe('*/5 * * * *');
      expect(call.origin.jobId).toMatch(/^[0-9a-f]{8}$/);
      // Content is wrapped in the cron-fire envelope (Bug A fix).
      expect(call.content).toHaveLength(1);
      const text = (call.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<cron-fire ');
      expect(text).toContain('<prompt>\ncheck the deploy\n</prompt>');
      // Exactly one envelope — guards against an accidental double-wrap
      // (e.g. handleFire calling renderCronFireXml on already-rendered
      // content from a future refactor).
      expect((text.match(/<cron-fire /g) ?? []).length).toBe(1);

      const eventEntries = ctx.allEvents.filter(
        (e): e is { type: '[rpc]'; event: 'cron.fired'; args: unknown } =>
          e.type === '[rpc]' && e.event === 'cron.fired',
      );
      expect(eventEntries).toHaveLength(1);
      expect(eventEntries[0]!.args).toMatchObject({
        prompt: 'check the deploy',
        origin: {
          kind: 'cron_job',
          cron: '*/5 * * * *',
          recurring: true,
          stale: false,
        },
      });

      const cronFiredTelemetry = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(cronFiredTelemetry).toHaveLength(1);
      const tc = cronFiredTelemetry[0]!;
      expect(tc.properties).toMatchObject({
        recurring: true,
        stale: false,
        buffered: false,
      });
    });
  });

  describe('handleFire — one-shot', () => {
    let harness: ReturnType<typeof createClocks>;
    let steerCalls: ReturnType<typeof createSteerSpy>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      telemetryRecords = captureTelemetry(telemetry);
      steerCalls = createSteerSpy(prompt);
    });

    it('uses recurring=false in origin and telemetry', () => {
      // Add a one-shot task that fires at the very next */5 mark, then
      // advance the wall clock past it.
      const task = cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'one-shot ping',
        recurring: false,
      });
      harness.advance(6 * 60_000);
      cron.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      expect(origin.kind).toBe('cron_job');
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.recurring).toBe(false);
      expect(origin.stale).toBe(false);
      // Content carries the cron-fire envelope around the verbatim prompt.
      const content = steerCalls[0]!.content;
      const text = (content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<cron-fire ');
      expect(text).toContain('recurring="false"');
      expect(text).toContain('<prompt>\none-shot ping\n</prompt>');

      const cronFiredTelemetry = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(cronFiredTelemetry[0]!.properties).toMatchObject({ recurring: false });

      // One-shot was removed from the store after fire.
      expect(cron.getTask(task.id)).toBeUndefined();
    });
  });

  describe('isStale', () => {
    let harness: ReturnType<typeof createClocks>;

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
    });

    it('flags recurring tasks older than 7 days as stale', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(cron.isStale(task)).toBe(true);
    });

    it('does not flag recurring tasks younger than 7 days', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 6 * ONE_DAY_MS,
        recurring: true,
      };
      expect(cron.isStale(task)).toBe(false);
    });

    it('treats undefined recurring as recurring for stale purposes', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        // recurring intentionally omitted
      };
      expect(cron.isStale(task)).toBe(true);
    });

    it('one-shot tasks are never stale even if old', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: false,
      };
      expect(cron.isStale(task)).toBe(false);
    });
  });

  describe('isStale with stale judgment disabled', () => {
    let harness: ReturnType<typeof createClocks>;

    beforeEach(() => {
      vi.stubEnv('KIMI_CRON_NO_STALE', '1');
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
    });

    it('KIMI_CRON_NO_STALE=1 disables stale judgment for recurring', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(cron.isStale(task)).toBe(false);
    });
  });

  describe('isStale with a broken clock', () => {
    beforeEach(() => {
      ctx = createTestAgent(
        cronServices({
          clocks: { wallNow: () => Number.NaN, monoNowMs: () => 0 },
          autoStart: false,
          pollIntervalMs: null,
        }),
      );
      cron = ctx.get(ICronService);
    });

    it('non-finite age is treated as not stale', () => {
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: 0,
        recurring: true,
      };
      expect(cron.isStale(task)).toBe(false);
    });
  });

  describe('stale propagation into fire origin', () => {
    let harness: ReturnType<typeof createClocks>;
    let steerCalls: ReturnType<typeof createSteerSpy>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      telemetryRecords = captureTelemetry(telemetry);
      steerCalls = createSteerSpy(prompt);
    });

    it('origin.stale === true for a recurring task older than 7 days', () => {
      // Add a recurring task whose createdAt is 8 days ago. Note: the
      // scheduler uses createdAt as the starting baseline for next-fire
      // computation, so a task that's been "alive" for 8 days will be
      // very overdue and will coalesce a lot of fires into one. That's
      // fine for this test — we only assert on `stale` (which is
      // computed from createdAt vs now) and `coalescedCount >= 1`.
      harness.setNow(harness.now() - 8 * ONE_DAY_MS);
      cron.addTask({ cron: '0 9 * * *', prompt: 'morning report', recurring: true });
      harness.setNow(WALL_ANCHOR);
      cron.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('expected cron_job');
      expect(origin.stale).toBe(true);
      const cronFiredTelemetry = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(cronFiredTelemetry[0]!.properties).toMatchObject({ stale: true });
      // Rendered envelope carries the stale flag too.
      const text = (steerCalls[0]!.content[0] as {
        type: 'text';
        text: string;
      }).text;
      expect(text).toContain('stale="true"');
    });

    it('stale recurring tasks get one final fire and are then removed', () => {
      // Mirrors the documented contract on `CronCreate.description`:
      // recurring tasks auto-expire after 7 days — they fire one final
      // time, then are deleted. Without this branch a session that
      // stays up past the stale threshold keeps re-injecting an old
      // cron prompt forever.
      harness.setNow(harness.now() - 8 * ONE_DAY_MS);
      cron.addTask({ cron: '*/5 * * * *', prompt: 'stale-recurring', recurring: true });
      harness.setNow(WALL_ANCHOR);
      expect(cron.store.list()).toHaveLength(1);

      cron.tick();
      expect(steerCalls.length).toBe(1);
      expect(cron.store.list()).toHaveLength(0);

      // A `cron_deleted` event closes the lifecycle in telemetry,
      // symmetric with manual `CronDelete` calls.
      const events = telemetryRecords.map((c) => c.event);
      expect(events).toContain('cron_fired');
      expect(events).toContain('cron_deleted');

      // No further fires after the task is gone.
      harness.advance(6 * 60_000);
      cron.tick();
      expect(steerCalls.length).toBe(1);
    });
  });

  describe('buffered semantics', () => {
    let harness: ReturnType<typeof createClocks>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      telemetryRecords = captureTelemetry(telemetry);
      createSteerSpy(prompt, undefined);
    });

    it('reports buffered=true on the telemetry event when steer returns null', () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'while-active' });
      harness.advance(6 * 60_000);
      cron.tick();

      const cronFiredTelemetry = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(cronFiredTelemetry).toHaveLength(1);
      expect(cronFiredTelemetry[0]!.properties).toMatchObject({ buffered: true });
    });
  });

  describe('idle gating', () => {
    let harness: ReturnType<typeof createClocks>;
    let hasActiveTurn: boolean;
    let steerCalls: ReturnType<typeof createSteerSpy>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      turn = ctx.get(ITurnService);
      telemetryRecords = captureTelemetry(telemetry);
      steerCalls = createSteerSpy(prompt);
      hasActiveTurn = true;
      vi.spyOn(turn, 'getActiveTurn').mockImplementation(() => {
        return hasActiveTurn
          ? {
            id: 1,
            abortController: new AbortController(),
            ready: Promise.resolve(),
            result: Promise.resolve({ reason: 'completed' as const }),
          }
          : undefined;
      });
    });

    it('does not fire while a turn is active', () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'ping' });
      harness.advance(6 * 60_000);
      cron.tick();
      expect(steerCalls.length).toBe(0);
      const firedBefore = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(firedBefore.length).toBe(0);

      // Flip back to idle and the next tick fires.
      hasActiveTurn = false;
      cron.tick();
      expect(steerCalls.length).toBe(1);
      const firedAfter = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(firedAfter.length).toBe(1);
    });
  });

  describe('end-to-end via scheduler', () => {
    let harness: ReturnType<typeof createClocks>;
    let steerCalls: ReturnType<typeof createSteerSpy>;

    beforeEach(() => {
      harness = createClocks();
      ctx = createTestAgent(
        cronServices({ clocks: harness.clocks, autoStart: false, pollIntervalMs: null }),
      );
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      steerCalls = createSteerSpy(prompt);
    });

    it('fires once with coalescedCount=1 after a 6-minute gap on */5', () => {
      cron.addTask({ cron: '*/5 * * * *', prompt: 'every five' });
      // Six minutes past the anchor — exactly one ideal fire in the gap.
      harness.advance(6 * 60_000);
      cron.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('expected cron_job');
      expect(origin.coalescedCount).toBe(1);
    });
  });

  describe('handleMissed', () => {
    let steerCalls: ReturnType<typeof createSteerSpy>;
    let telemetryRecords: TelemetryRecord[];

    beforeEach(() => {
      ctx = createTestAgent(cronServices({ autoStart: false, pollIntervalMs: null }));
      cron = ctx.get(ICronService);
      prompt = ctx.get(IPromptService);
      telemetry = ctx.get(ITelemetryService);
      telemetryRecords = captureTelemetry(telemetry);
      steerCalls = createSteerSpy(prompt);
    });

    it('no-ops on an empty task list', () => {
      cron.handleMissed([], () => [{ type: 'text', text: 'should not run' }]);
      expect(steerCalls.length).toBe(0);
      expect(telemetryRecords.length).toBe(0);
    });

    it('steers cron_missed origin and emits cron_missed telemetry', () => {
      const tasks: CronTask[] = [
        {
          id: '11111111',
          cron: '0 9 * * *',
          prompt: 'a',
          createdAt: 1,
          recurring: false,
        },
        {
          id: '22222222',
          cron: '0 10 * * *',
          prompt: 'b',
          createdAt: 2,
          recurring: false,
        },
      ];
      const rendered: ContentPart[] = [
        { type: 'text', text: 'You missed 2 one-shot tasks.' },
      ];
      cron.handleMissed(tasks, () => rendered);

      expect(steerCalls.length).toBe(1);
      const call = steerCalls[0]!;
      expect(call.content).toStrictEqual(rendered);
      expect(call.origin.kind).toBe('cron_missed');
      if (call.origin.kind !== 'cron_missed') throw new Error('unreachable');
      expect(call.origin.count).toBe(2);

      const cronMissedTelemetry = telemetryRecords.filter((r) => r.event === CRON_MISSED);
      expect(cronMissedTelemetry).toHaveLength(1);
      expect(cronMissedTelemetry[0]!.properties).toEqual({ count: 2 });
    });
  });
});
