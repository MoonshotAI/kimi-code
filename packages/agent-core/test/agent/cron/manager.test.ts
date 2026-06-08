/**
 * Tests for `agent/cron/manager.ts`. Uses a lightweight Agent stub
 * (see ./harness/stub) — only the three surfaces the manager touches
 * (turn.hasActiveTurn, turn.steer, telemetry.track) need to look real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentPart } from '@moonshot-ai/kosong';

import { CronManager } from '../../../src/agent/cron/manager';
import type { ClockSources } from '../../../src/tools/cron/clock';
import {
  CRON_FIRED,
  CRON_MISSED,
} from '../../../src/tools/cron/telemetry-events';
import type { CronTask } from '../../../src/tools/cron/types';
import {
  createAgentStub,
  createClocks,
  WALL_ANCHOR,
} from './harness/stub';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
      const { agent } = createAgentStub();
      // Disable the auto-tick timer so the test doesn't have to wait
      // for setInterval / clean it up; we just want start() and stop()
      // to be wired and idempotent.
      const manager = new CronManager(agent, { pollIntervalMs: null });
      expect(() => manager.start()).not.toThrow();
      expect(() => manager.start()).not.toThrow(); // idempotent
      await expect(manager.stop()).resolves.toBeUndefined();
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('exposes the session store as an empty list on construction', () => {
      const { agent } = createAgentStub();
      const manager = new CronManager(agent, { pollIntervalMs: null });
      expect(manager.store.list()).toEqual([]);
      expect(manager.getNextFireTime()).toBeNull();
    });

    it('getNextFireForTask delegates to the scheduler', () => {
      const { agent } = createAgentStub();
      const manager = new CronManager(agent, { pollIntervalMs: null });
      const scheduler = (manager as unknown as {
        scheduler: { getNextFireForTask: (id: string) => number | null };
      }).scheduler;
      const spy = vi.spyOn(scheduler, 'getNextFireForTask').mockReturnValue(123);
      expect(manager.getNextFireForTask('deadbeef')).toBe(123);
      expect(spy).toHaveBeenCalledWith('deadbeef');
    });
  });

  describe('handleFire — recurring', () => {
    it('steers with cron_job origin and emits cron_fired telemetry', () => {
      const stub = createAgentStub({ steerReturns: 7 });
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });

      manager.store.add(
        { cron: '*/5 * * * *', prompt: 'check the deploy' },
        harness.now() - 1,
      );
      // `*/5 * * * *` lands every 5 minutes; bump 6 minutes so we are
      // safely past exactly one ideal fire.
      harness.advance(6 * 60_000);
      manager.tick();

      expect(stub.steerCalls.length).toBe(1);
      const call = stub.steerCalls[0]!;
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

      expect(stub.eventCalls).toHaveLength(1);
      expect(stub.eventCalls[0]!.event).toMatchObject({
        type: 'cron.fired',
        prompt: 'check the deploy',
        origin: {
          kind: 'cron_job',
          cron: '*/5 * * * *',
          recurring: true,
          stale: false,
        },
      });

      expect(stub.telemetryCalls.length).toBe(1);
      const tc = stub.telemetryCalls[0]!;
      expect(tc.event).toBe(CRON_FIRED);
      expect(tc.props).toMatchObject({
        recurring: true,
        stale: false,
        buffered: false,
      });
    });
  });

  describe('handleFire — one-shot', () => {
    it('uses recurring=false in origin and telemetry', () => {
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });

      // Add a one-shot task that fires at the very next */5 mark, then
      // advance the wall clock past it.
      const task = manager.store.add(
        {
          cron: '*/5 * * * *',
          prompt: 'one-shot ping',
          recurring: false,
        },
        harness.now() - 1,
      );
      harness.advance(6 * 60_000);
      manager.tick();

      expect(stub.steerCalls.length).toBe(1);
      const origin = stub.steerCalls[0]!.origin;
      expect(origin.kind).toBe('cron_job');
      if (origin.kind !== 'cron_job') throw new Error('unreachable');
      expect(origin.recurring).toBe(false);
      expect(origin.stale).toBe(false);
      // Content carries the cron-fire envelope around the verbatim prompt.
      const content = stub.steerCalls[0]!.content;
      const text = (content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('<cron-fire ');
      expect(text).toContain('recurring="false"');
      expect(text).toContain('<prompt>\none-shot ping\n</prompt>');

      const tc = stub.telemetryCalls[0]!;
      expect(tc.props).toMatchObject({ recurring: false });

      // One-shot was removed from the store after fire.
      expect(manager.store.get(task.id)).toBeUndefined();
    });
  });

  describe('isStale', () => {
    it('flags recurring tasks older than 7 days as stale', () => {
      const { agent } = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });

      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(manager.isStale(task)).toBe(true);
    });

    it('does not flag recurring tasks younger than 7 days', () => {
      const { agent } = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 6 * ONE_DAY_MS,
        recurring: true,
      };
      expect(manager.isStale(task)).toBe(false);
    });

    it('treats undefined recurring as recurring for stale purposes', () => {
      const { agent } = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        // recurring intentionally omitted
      };
      expect(manager.isStale(task)).toBe(true);
    });

    it('one-shot tasks are never stale even if old', () => {
      const { agent } = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: false,
      };
      expect(manager.isStale(task)).toBe(false);
    });

    it('KIMI_CRON_NO_STALE=1 disables stale judgment for recurring', () => {
      vi.stubEnv('KIMI_CRON_NO_STALE', '1');
      const { agent } = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: harness.now() - 8 * ONE_DAY_MS,
        recurring: true,
      };
      expect(manager.isStale(task)).toBe(false);
    });

    it('non-finite age (broken clock) is treated as not stale', () => {
      const { agent } = createAgentStub();
      const brokenClocks: ClockSources = {
        wallNow: () => Number.NaN,
        monoNowMs: () => 0,
      };
      const manager = new CronManager(agent, {
        clocks: brokenClocks,
        pollIntervalMs: null,
      });
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning report',
        createdAt: 0,
        recurring: true,
      };
      expect(manager.isStale(task)).toBe(false);
    });
  });

  describe('stale propagation into fire origin', () => {
    it('origin.stale === true for a recurring task older than 7 days', () => {
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });

      // Add a recurring task whose createdAt is 8 days ago. Note: the
      // scheduler uses createdAt as the starting baseline for next-fire
      // computation, so a task that's been "alive" for 8 days will be
      // very overdue and will coalesce a lot of fires into one. That's
      // fine for this test — we only assert on `stale` (which is
      // computed from createdAt vs now) and `coalescedCount >= 1`.
      manager.store.add(
        { cron: '0 9 * * *', prompt: 'morning report', recurring: true },
        harness.now() - 8 * ONE_DAY_MS,
      );
      manager.tick();

      expect(stub.steerCalls.length).toBe(1);
      const origin = stub.steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('expected cron_job');
      expect(origin.stale).toBe(true);
      expect(stub.telemetryCalls[0]!.props).toMatchObject({ stale: true });
      // Rendered envelope carries the stale flag too.
      const text = (stub.steerCalls[0]!.content[0] as {
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
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      manager.store.add(
        { cron: '*/5 * * * *', prompt: 'stale-recurring', recurring: true },
        harness.now() - 8 * ONE_DAY_MS,
      );
      expect(manager.store.list()).toHaveLength(1);

      manager.tick();
      expect(stub.steerCalls.length).toBe(1);
      expect(manager.store.list()).toHaveLength(0);

      // A `cron_deleted` event closes the lifecycle in telemetry,
      // symmetric with manual `CronDelete` calls.
      const events = stub.telemetryCalls.map((c) => c.event);
      expect(events).toContain('cron_fired');
      expect(events).toContain('cron_deleted');

      // No further fires after the task is gone.
      harness.advance(6 * 60_000);
      manager.tick();
      expect(stub.steerCalls.length).toBe(1);
    });
  });

  describe('buffered semantics', () => {
    it('reports buffered=true on the telemetry event when steer returns null', () => {
      const stub = createAgentStub({ steerReturns: null });
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      manager.store.add(
        { cron: '*/5 * * * *', prompt: 'while-active' },
        harness.now() - 1,
      );
      harness.advance(6 * 60_000);
      manager.tick();

      expect(stub.telemetryCalls.length).toBe(1);
      expect(stub.telemetryCalls[0]!.props).toMatchObject({ buffered: true });
    });
  });

  describe('idle gating', () => {
    it('does not fire while a turn is active', () => {
      const stub = createAgentStub({ hasActiveTurn: true });
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      manager.store.add(
        { cron: '*/5 * * * *', prompt: 'ping' },
        harness.now() - 1,
      );
      harness.advance(6 * 60_000);
      manager.tick();
      expect(stub.steerCalls.length).toBe(0);
      expect(stub.telemetryCalls.length).toBe(0);

      // Flip back to idle and the next tick fires.
      stub.setHasActiveTurn(false);
      manager.tick();
      expect(stub.steerCalls.length).toBe(1);
    });
  });

  describe('end-to-end via scheduler', () => {
    it('fires once with coalescedCount=1 after a 6-minute gap on */5', () => {
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      manager.store.add(
        { cron: '*/5 * * * *', prompt: 'every five' },
        harness.now() - 1,
      );
      // Six minutes past the anchor — exactly one ideal fire in the gap.
      harness.advance(6 * 60_000);
      manager.tick();

      expect(stub.steerCalls.length).toBe(1);
      const origin = stub.steerCalls[0]!.origin;
      if (origin.kind !== 'cron_job') throw new Error('expected cron_job');
      expect(origin.coalescedCount).toBe(1);
    });
  });

  describe('handleMissed', () => {
    it('no-ops on an empty task list', () => {
      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      manager.handleMissed([], () => [{ type: 'text', text: 'should not run' }]);
      expect(stub.steerCalls.length).toBe(0);
      expect(stub.telemetryCalls.length).toBe(0);
    });

    it('steers cron_missed origin and emits cron_missed telemetry', () => {
      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });

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
      manager.handleMissed(tasks, () => rendered);

      expect(stub.steerCalls.length).toBe(1);
      const call = stub.steerCalls[0]!;
      expect(call.content).toBe(rendered);
      expect(call.origin.kind).toBe('cron_missed');
      if (call.origin.kind !== 'cron_missed') throw new Error('unreachable');
      expect(call.origin.count).toBe(2);

      expect(stub.telemetryCalls.length).toBe(1);
      expect(stub.telemetryCalls[0]!.event).toBe(CRON_MISSED);
      expect(stub.telemetryCalls[0]!.props).toEqual({ count: 2 });
    });
  });
});
