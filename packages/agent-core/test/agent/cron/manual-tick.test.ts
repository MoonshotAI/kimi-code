/**
 * P1.8 — Manual tick + SIGUSR1.
 *
 * Two env / signal affordances live on `CronManager`:
 *
 *   1. `KIMI_CRON_MANUAL_TICK=1` forces `pollIntervalMs: null` in the
 *      scheduler so no `setInterval` is installed. Bench / time-injected
 *      tests can then call `manager.tick()` explicitly without racing a
 *      1-second auto-tick.
 *   2. `process.on('SIGUSR1', () => manager.tick())` lets a bench script
 *      run `kill -USR1 <pid>` to advance the scheduler manually. The
 *      handler is bound in `start()` and removed in `stop()` so vitest
 *      files don't leak listeners across the shared process.
 *
 * The default Agent stub here is identical in spirit to the one in
 * `manager.test.ts` — kept inline so this file is independently
 * readable; the cost of the small copy is offset by the clarity of
 * having all P1.8 assertions in one place.
 */
import type { ContentPart } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { PromptOrigin } from '../../../src/agent/context/types';
import { CronManager } from '../../../src/agent/cron/manager';
import type { ClockSources } from '../../../src/tools/cron/clock';

const WALL_ANCHOR = 1_700_000_000_000;

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

function createAgentStub(): {
  agent: Agent;
  steerCalls: SteerCall[];
} {
  const steerCalls: SteerCall[] = [];
  const turn = {
    get hasActiveTurn(): boolean {
      return false;
    },
    steer: (content: readonly ContentPart[], origin: PromptOrigin) => {
      steerCalls.push({ content, origin });
      return 1;
    },
  };
  const telemetry = {
    track: () => {
      /* no-op for P1.8 — assertions here are on steer / signals */
    },
  };
  const agent = { turn, telemetry } as unknown as Agent;
  return { agent, steerCalls };
}

function createClocks(initial = WALL_ANCHOR): {
  clocks: ClockSources;
  advance(ms: number): void;
  now(): number;
} {
  let wall = initial;
  let mono = 1_000_000;
  return {
    clocks: {
      wallNow: () => wall,
      monoNowMs: () => mono,
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
  };
}

describe('CronManager — P1.8 manual tick + SIGUSR1', () => {
  beforeEach(() => {
    // Disable jitter so fire-count assertions are deterministic.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('KIMI_CRON_MANUAL_TICK=1', () => {
    it('does not install setInterval; tick() must be called manually', async () => {
      vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');

      const stub = createAgentStub();
      const harness = createClocks();
      // Caller passes pollIntervalMs: 50 — but the env flag overrides
      // it, so no auto-tick should run even after we wait real time.
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: 50,
      });
      try {
        manager.start();

        manager.store.add(
          { cron: '*/5 * * * *', prompt: 'manual-only' },
          harness.now() - 1,
        );
        harness.advance(6 * 60_000);

        // Real-time wait: if an interval were registered, 50ms is more
        // than enough to fire at least once. We do NOT use fake timers
        // here because the whole point is to prove no timer exists.
        await new Promise((r) => setTimeout(r, 50));
        expect(stub.steerCalls.length).toBe(0);

        // Manual drive → fires.
        manager.tick();
        expect(stub.steerCalls.length).toBe(1);
      } finally {
        await manager.stop();
      }
    });
  });

  describe('without KIMI_CRON_MANUAL_TICK', () => {
    it('auto-tick fires when fake timers advance past pollIntervalMs', async () => {
      // Fake timers must be in place BEFORE the manager calls
      // setInterval, otherwise the scheduler captures the real one.
      vi.useFakeTimers();

      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: 50,
      });
      try {
        manager.start();

        manager.store.add(
          { cron: '*/5 * * * *', prompt: 'auto-tick' },
          harness.now() - 1,
        );
        // Move the injected wall clock past one ideal fire, then let the
        // setInterval drain by advancing fake timers past one poll.
        harness.advance(6 * 60_000);
        vi.advanceTimersByTime(60);

        expect(stub.steerCalls.length).toBe(1);
      } finally {
        await manager.stop();
      }
    });
  });

  describe('SIGUSR1', () => {
    // SIGUSR1 binding is opt-in via KIMI_CRON_MANUAL_TICK=1 so that
    // production (1 main agent + N subagents) doesn't pile up listeners
    // and trip Node's MaxListenersExceededWarning cap. All four SIGUSR1
    // tests stub the env before constructing the manager.
    beforeEach(() => {
      vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
    });

    it('triggers manager.tick() once per emit (POSIX only)', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      try {
        manager.start();
        const spy = vi.spyOn(manager, 'tick');
        process.emit('SIGUSR1', 'SIGUSR1');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await manager.stop();
      }
    });

    it('swallows throws from tick() so the host process never crashes', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      try {
        manager.start();
        vi.spyOn(manager, 'tick').mockImplementation(() => {
          throw new Error('boom');
        });
        // If the handler re-threw, this `emit` would propagate. The
        // assertion below is the "no throw" side-effect.
        expect(() => process.emit('SIGUSR1', 'SIGUSR1')).not.toThrow();
      } finally {
        await manager.stop();
      }
    });

    it('stop() removes the SIGUSR1 listener (no leak)', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      const before = process.listenerCount('SIGUSR1');
      manager.start();
      expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
      await manager.stop();
      expect(process.listenerCount('SIGUSR1')).toBe(before);
    });

    it('start() is idempotent — second call does not double-bind', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      const before = process.listenerCount('SIGUSR1');
      try {
        manager.start();
        manager.start();
        expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
      } finally {
        await manager.stop();
      }
    });

    it('does not bind when KIMI_CRON_MANUAL_TICK is unset', async () => {
      if (process.platform === 'win32') return;
      // Override the describe-scope stub so the env is genuinely unset.
      vi.unstubAllEnvs();
      // Re-pin jitter so other describe-scope state stays consistent.
      vi.stubEnv('KIMI_CRON_NO_JITTER', '1');

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      const before = process.listenerCount('SIGUSR1');
      try {
        manager.start();
        expect(process.listenerCount('SIGUSR1')).toBe(before);
      } finally {
        await manager.stop();
      }
    });
  });
});
