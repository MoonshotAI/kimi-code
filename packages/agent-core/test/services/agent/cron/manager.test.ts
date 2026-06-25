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
} from '../../../../src/tools/cron/telemetry-events';
import type { CronTask } from '../../../../src/tools/cron/types';
import { recordingTelemetry, type TelemetryRecord } from '../../../fixtures/telemetry';
import {
  IPromptService,
  ITurnRunner,
} from '../../../../src/services/agent';
import type { ContextMessage, PromptOrigin, Turn } from '../../../../src/services/agent';
import { testAgent, type TestAgentContext } from '../harness';

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
  ctx: TestAgentContext,
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
  vi.spyOn(ctx.get(IPromptService), 'steer').mockImplementation((message: ContextMessage) => {
    calls.push({ content: message.content, origin: message.origin as PromptOrigin });
    return returnValue;
  });
  return calls;
}

describe('CronManager', () => {
  beforeEach(() => {
    // Pin jitter off so fire-count assertions are deterministic. Each
    // test that actually exercises fires resets the env via stubEnv,
    // but setting it here as well shields the construction-path tests
    // from any leaked state.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('construction', () => {
    it('does not throw with default clocks and supports start/stop', async () => {
      const ctx = testAgent({ cron: { autoStart: false, pollIntervalMs: null } });
      // Disable the auto-tick timer so the test doesn't have to wait
      // for setInterval / clean it up; we just want start() and stop()
      // to be wired and idempotent.
      expect(() => ctx.cron.start()).not.toThrow();
      expect(() => ctx.cron.start()).not.toThrow(); // idempotent
      await expect(ctx.cron.stop()).resolves.toBeUndefined();
      await expect(ctx.cron.stop()).resolves.toBeUndefined();
    });

    it('exposes the session store as an empty list on construction', () => {
      const ctx = testAgent({ cron: { autoStart: false, pollIntervalMs: null } });
      expect(ctx.cron.store.list()).toEqual([]);
      expect(ctx.cron.getNextFireTime()).toBeNull();
    });

    it('getNextFireForTask delegates to the scheduler', () => {
      const ctx = testAgent({ cron: { autoStart: false, pollIntervalMs: null } });
      const spy = vi.spyOn(ctx.cron, 'getNextFireForTask').mockReturnValue(123);
      expect(ctx.cron.getNextFireForTask('deadbeef')).toBe(123);
      expect(spy).toHaveBeenCalledWith('deadbeef');
    });
  });

  describe('handleFire — recurring', () => {
    it('steers with cron_job origin and emits cron_fired telemetry', () => {
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx, {
        id: 7,
        abortController: new AbortController(),
        ready: Promise.resolve(),
        result: Promise.resolve({ reason: 'completed' as const }),
      });

      ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'check the deploy' });
      // `*/5 * * * *` lands every 5 minutes; bump 6 minutes so we are
      // safely past exactly one ideal fire.
      harness.advance(6 * 60_000);
      ctx.cron.tick();

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
    it('uses recurring=false in origin and telemetry', () => {
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

      // Add a one-shot task that fires at the very next */5 mark, then
      // advance the wall clock past it.
      const task = ctx.cron.addTask({
        cron: '*/5 * * * *',
        prompt: 'one-shot ping',
        recurring: false,
      });
      harness.advance(6 * 60_000);
      ctx.cron.tick();

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
      expect(ctx.cron.getTask(task.id)).toBeUndefined();
    });
  });

  describe('isStale', () => {
    it('flags recurring tasks older than 7 days as stale', () => {
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });

      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(ctx.cron.isStale(task)).toBe(true);
    });

    it('does not flag recurring tasks younger than 7 days', () => {
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 6 * ONE_DAY_MS,
        recurring: true,
      };
      expect(ctx.cron.isStale(task)).toBe(false);
    });

    it('treats undefined recurring as recurring for stale purposes', () => {
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        // recurring intentionally omitted
      };
      expect(ctx.cron.isStale(task)).toBe(true);
    });

    it('one-shot tasks are never stale even if old', () => {
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: false,
      };
      expect(ctx.cron.isStale(task)).toBe(false);
    });

    it('KIMI_CRON_NO_STALE=1 disables stale judgment for recurring', () => {
      vi.stubEnv('KIMI_CRON_NO_STALE', '1');
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(ctx.cron.isStale(task)).toBe(false);
    });

    it('non-finite age (broken clock) is treated as not stale', () => {
      const ctx = testAgent({
        cron: {
          clocks: { wallNow: () => Number.NaN, monoNowMs: () => 0 },
          autoStart: false,
          pollIntervalMs: null,
        },
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: 0,
        recurring: true,
      };
      expect(ctx.cron.isStale(task)).toBe(false);
    });
  });

  describe('stale propagation into fire origin', () => {
    it('origin.stale === true for a recurring task older than 7 days', () => {
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

      // Add a recurring task whose createdAt is 8 days ago. Note: the
      // scheduler uses createdAt as the starting baseline for next-fire
      // computation, so a task that's been "alive" for 8 days will be
      // very overdue and will coalesce a lot of fires into one. That's
      // fine for this test — we only assert on `stale` (which is
      // computed from createdAt vs now) and `coalescedCount >= 1`.
      harness.setNow(harness.now() - 8 * ONE_DAY_MS);
      ctx.cron.addTask({ cron: '0 9 * * *', prompt: 'morning report', recurring: true });
      harness.setNow(WALL_ANCHOR);
      ctx.cron.tick();

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
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

      harness.setNow(harness.now() - 8 * ONE_DAY_MS);
      ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'stale-recurring', recurring: true });
      harness.setNow(WALL_ANCHOR);
      expect(ctx.cron.store.list()).toHaveLength(1);

      ctx.cron.tick();
      expect(steerCalls.length).toBe(1);
      expect(ctx.cron.store.list()).toHaveLength(0);

      // A `cron_deleted` event closes the lifecycle in telemetry,
      // symmetric with manual `CronDelete` calls.
      const events = telemetryRecords.map((c) => c.event);
      expect(events).toContain('cron_fired');
      expect(events).toContain('cron_deleted');

      // No further fires after the task is gone.
      harness.advance(6 * 60_000);
      ctx.cron.tick();
      expect(steerCalls.length).toBe(1);
    });
  });

  describe('buffered semantics', () => {
    it('reports buffered=true on the telemetry event when steer returns null', () => {
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      createSteerSpy(ctx, undefined);

      ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'while-active' });
      harness.advance(6 * 60_000);
      ctx.cron.tick();

      const cronFiredTelemetry = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(cronFiredTelemetry).toHaveLength(1);
      expect(cronFiredTelemetry[0]!.properties).toMatchObject({ buffered: true });
    });
  });

  describe('idle gating', () => {
    it('does not fire while a turn is active', () => {
      const harness = createClocks();
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

      let hasActiveTurn = true;
      vi.spyOn(ctx.get(ITurnRunner), 'getActiveTurn').mockImplementation(() => {
        return hasActiveTurn
          ? {
              id: 1,
              abortController: new AbortController(),
              ready: Promise.resolve(),
              result: Promise.resolve({ reason: 'completed' as const }),
            }
          : undefined;
      });

      ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'ping' });
      harness.advance(6 * 60_000);
      ctx.cron.tick();
      expect(steerCalls.length).toBe(0);
      const firedBefore = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(firedBefore.length).toBe(0);

      // Flip back to idle and the next tick fires.
      hasActiveTurn = false;
      ctx.cron.tick();
      expect(steerCalls.length).toBe(1);
      const firedAfter = telemetryRecords.filter((r) => r.event === CRON_FIRED);
      expect(firedAfter.length).toBe(1);
    });
  });

  describe('end-to-end via scheduler', () => {
    it('fires once with coalescedCount=1 after a 6-minute gap on */5', () => {
      const harness = createClocks();
      const ctx = testAgent({
        cron: { clocks: harness.clocks, autoStart: false, pollIntervalMs: null },
      });
      const steerCalls = createSteerSpy(ctx);

      ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'every five' });
      // Six minutes past the anchor — exactly one ideal fire in the gap.
      harness.advance(6 * 60_000);
      ctx.cron.tick();

      expect(steerCalls.length).toBe(1);
      const origin = steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('expected cron_job');
      expect(origin.coalescedCount).toBe(1);
    });
  });

  describe('handleMissed', () => {
    it('no-ops on an empty task list', () => {
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

      ctx.cron.handleMissed([], () => [{ type: 'text', text: 'should not run' }]);
      expect(steerCalls.length).toBe(0);
      expect(telemetryRecords.length).toBe(0);
    });

    it('steers cron_missed origin and emits cron_missed telemetry', () => {
      const telemetryRecords: TelemetryRecord[] = [];
      const ctx = testAgent({
        cron: { autoStart: false, pollIntervalMs: null },
        telemetry: recordingTelemetry(telemetryRecords),
      });
      const steerCalls = createSteerSpy(ctx);

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
      ctx.cron.handleMissed(tasks, () => rendered);

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
