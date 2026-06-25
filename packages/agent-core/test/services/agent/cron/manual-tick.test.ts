/**
 * Tests for `services/agent/cron/cronService.ts` P1.8 affordances: the
 * `KIMI_CRON_MANUAL_TICK=1` env disables the auto-tick interval and,
 * in the same gate, binds SIGUSR1 to a no-throw `tick()` for benches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPromptService, type ContextMessage } from '../../../../src/services/agent';
import { testAgent } from '../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface ClockHarness {
  readonly clocks: { wallNow(): number; monoNowMs(): number };
  /** Advance wall + mono by `ms`. */
  advance(ms: number): void;
  /** Current wall-clock value. */
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
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
  };
}

function spySteer(ctx: ReturnType<typeof testAgent>) {
  return vi.spyOn(ctx.get(IPromptService), 'steer').mockImplementation((_message: ContextMessage) => ({
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' as const }),
  }));
}

describe('CronService — P1.8 manual tick + SIGUSR1', () => {
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

      const harness = createClocks();
      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: 50, clocks: harness.clocks },
      });
      const steerSpy = spySteer(ctx);
      try {
        ctx.cron.start();

        ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'manual-only' });
        harness.advance(6 * 60_000);

        // Real-time wait: if an interval were registered, 50ms is more
        // than enough to fire at least once. We do NOT use fake timers
        // here because the whole point is to prove no timer exists.
        await new Promise((r) => setTimeout(r, 50));
        expect(steerSpy).toHaveBeenCalledTimes(0);

        // Manual drive → fires.
        ctx.cron.tick();
        expect(steerSpy).toHaveBeenCalledTimes(1);
      } finally {
        await ctx.cron.stop();
      }
    });
  });

  describe('without KIMI_CRON_MANUAL_TICK', () => {
    it('auto-tick fires when fake timers advance past pollIntervalMs', async () => {
      // Fake timers must be in place BEFORE the manager calls
      // setInterval, otherwise the scheduler captures the real one.
      vi.useFakeTimers();

      const harness = createClocks();
      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: 50, clocks: harness.clocks },
      });
      const steerSpy = spySteer(ctx);
      try {
        ctx.cron.start();

        ctx.cron.addTask({ cron: '*/5 * * * *', prompt: 'auto-tick' });
        // Move the injected wall clock past one ideal fire, then let the
        // setInterval drain by advancing fake timers past one poll.
        harness.advance(6 * 60_000);
        vi.advanceTimersByTime(60);

        expect(steerSpy).toHaveBeenCalledTimes(1);
      } finally {
        await ctx.cron.stop();
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

    it('triggers tick() once per emit (POSIX only)', async () => {
      if (process.platform === 'win32') return;

      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      try {
        ctx.cron.start();
        const spy = vi.spyOn(ctx.cron, 'tick');
        process.emit('SIGUSR1', 'SIGUSR1');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        await ctx.cron.stop();
      }
    });

    it('swallows throws from tick() so the host process never crashes', async () => {
      if (process.platform === 'win32') return;

      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      try {
        ctx.cron.start();
        vi.spyOn(ctx.cron, 'tick').mockImplementation(() => {
          throw new Error('boom');
        });
        // If the handler re-threw, this `emit` would propagate. The
        // assertion below is the "no throw" side-effect.
        expect(() => process.emit('SIGUSR1', 'SIGUSR1')).not.toThrow();
      } finally {
        await ctx.cron.stop();
      }
    });

    it('logs swallowed tick() throws to stderr when KIMI_CRON_DEBUG=1', async () => {
      if (process.platform === 'win32') return;
      vi.stubEnv('KIMI_CRON_DEBUG', '1');

      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        ctx.cron.start();
        vi.spyOn(ctx.cron, 'tick').mockImplementation(() => {
          throw new Error('debug-boom');
        });
        process.emit('SIGUSR1', 'SIGUSR1');
        expect(writeSpy).toHaveBeenCalled();
        const calls = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(calls.some((s) => /cron\/service.*SIGUSR1/.test(s))).toBe(
          true,
        );
        expect(calls.some((s) => s.includes('debug-boom'))).toBe(true);
      } finally {
        writeSpy.mockRestore();
        await ctx.cron.stop();
      }
    });

    it('does not write to stderr on tick() throw when KIMI_CRON_DEBUG is unset', async () => {
      if (process.platform === 'win32') return;
      // KIMI_CRON_DEBUG intentionally NOT set in this test.

      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        ctx.cron.start();
        vi.spyOn(ctx.cron, 'tick').mockImplementation(() => {
          throw new Error('silent-boom');
        });
        process.emit('SIGUSR1', 'SIGUSR1');
        // No cron/service line was emitted because debug is off.
        const calls = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(calls.some((s) => /cron\/service/.test(s))).toBe(false);
      } finally {
        writeSpy.mockRestore();
        await ctx.cron.stop();
      }
    });

    it('stop() removes the SIGUSR1 listener (no leak)', async () => {
      if (process.platform === 'win32') return;

      const before = process.listenerCount('SIGUSR1');
      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      // Constructor auto-starts, which binds SIGUSR1 under KIMI_CRON_MANUAL_TICK=1.
      expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
      await ctx.cron.stop();
      expect(process.listenerCount('SIGUSR1')).toBe(before);
    });

    it('start() is idempotent — second call does not double-bind', async () => {
      if (process.platform === 'win32') return;

      const before = process.listenerCount('SIGUSR1');
      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      // Constructor already calls start() once; an explicit second
      // call must not stack a handler.
      try {
        ctx.cron.start();
        expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
      } finally {
        await ctx.cron.stop();
      }
    });

    it('does not bind when KIMI_CRON_MANUAL_TICK is unset', async () => {
      if (process.platform === 'win32') return;
      // Override the describe-scope stub so the env is genuinely unset.
      vi.unstubAllEnvs();
      // Re-pin jitter so other describe-scope state stays consistent.
      vi.stubEnv('KIMI_CRON_NO_JITTER', '1');

      const ctx = testAgent({
        cron: { autoStart: true, pollIntervalMs: null },
      });
      const before = process.listenerCount('SIGUSR1');
      try {
        ctx.cron.start();
        expect(process.listenerCount('SIGUSR1')).toBe(before);
      } finally {
        await ctx.cron.stop();
      }
    });
  });
});
