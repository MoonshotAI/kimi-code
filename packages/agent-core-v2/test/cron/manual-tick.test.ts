/**
 * Tests for `services/agent/cron/cronService.ts` P1.8 affordances: the
 * `KIMI_CRON_MANUAL_TICK=1` env disables the auto-tick interval and,
 * in the same gate, binds SIGUSR1 to a no-throw `tick()` for benches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { createTestAgent, cronServices, type TestAgentContext } from '../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface ClockHarness {
  /** Advance wall-clock time by `ms`. */
  advance(ms: number): void;
  /** Current wall-clock value. */
  now(): number;
}

function createClocks(initial: number = WALL_ANCHOR): ClockHarness {
  let wall = initial;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  return {
    advance: (ms) => {
      wall += ms;
    },
    now: () => wall,
  };
}

function spySteer(prompt: IAgentPromptService) {
  return vi.spyOn(prompt, 'steer').mockImplementation((_message: ContextMessage) => ({
    removeFromQueue: () => {},
    launched: Promise.resolve({
      id: 1,
      signal: new AbortController().signal,
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed' as const, steps: 0, truncated: false }),
    }),
  }));
}

describe('SessionCronService — P1.8 manual tick + SIGUSR1', () => {
  beforeEach(() => {
    // Disable jitter so fire-count assertions are deterministic.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('KIMI_CRON_MANUAL_TICK=1', () => {
    let ctx: TestAgentContext;
    let cron: ISessionCronService;
    let prompt: IAgentPromptService;
    let harness: ClockHarness;

    beforeEach(() => {
      vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
      harness = createClocks();
      ctx = createTestAgent(cronServices());
      cron = ctx.get(ISessionCronService);
      prompt = ctx.get(IAgentPromptService);
    });

    afterEach(async () => {
      await ctx.dispose();
    });

    it('does not install setInterval; tick() must be called manually', async () => {
      const steerSpy = spySteer(prompt);

      await cron.start();
      cron.addTask({ cron: '*/5 * * * *', prompt: 'manual-only' });
      harness.advance(6 * 60_000);

      // Real-time wait: if an interval were registered, 50ms is more
      // than enough to fire at least once. We do NOT use fake timers
      // here because the whole point is to prove no timer exists.
      await new Promise((r) => setTimeout(r, 50));
      expect(steerSpy).toHaveBeenCalledTimes(0);

      // Manual drive → fires.
      await cron.tick();
      expect(steerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('without KIMI_CRON_MANUAL_TICK', () => {
    let ctx: TestAgentContext;
    let cron: ISessionCronService;
    let prompt: IAgentPromptService;
    let harness: ClockHarness;

    beforeEach(() => {
      // Fake timers must be in place BEFORE the manager calls
      // setInterval, otherwise the scheduler captures the real one.
      vi.useFakeTimers();
      vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '50');
      harness = createClocks();
      ctx = createTestAgent(cronServices());
      cron = ctx.get(ISessionCronService);
      prompt = ctx.get(IAgentPromptService);
    });

    afterEach(async () => {
      await ctx.dispose();
    });

    it('auto-tick fires when fake timers advance past pollIntervalMs', async () => {
      const steerSpy = spySteer(prompt);

      await cron.start();
      cron.addTask({ cron: '*/5 * * * *', prompt: 'auto-tick' });
      // Move the injected wall clock past one ideal fire, then let the
      // setInterval drain by advancing fake timers past one poll.
      harness.advance(6 * 60_000);
      vi.advanceTimersByTime(60);

      expect(steerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('SIGUSR1', () => {
    // SIGUSR1 binding is opt-in via KIMI_CRON_MANUAL_TICK=1 so that
    // production (1 main agent + N subagents) doesn't pile up listeners
    // and trip Node's MaxListenersExceededWarning cap.
    describe('manual tick enabled', () => {
      let ctx: TestAgentContext;
      let cron: ISessionCronService;
      let listenerCountBeforeCreate: number;

      beforeEach(() => {
        vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
        listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
        ctx = createTestAgent(cronServices());
        cron = ctx.get(ISessionCronService);
      });

      afterEach(async () => {
        await ctx.dispose();
      });

      it('triggers tick() once per emit (POSIX only)', () => {
        if (process.platform === 'win32') return;

        const spy = vi.spyOn(cron, 'tick');
        process.emit('SIGUSR1', 'SIGUSR1');
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('swallows throws from tick() so the host process never crashes', () => {
        if (process.platform === 'win32') return;

        vi.spyOn(cron, 'tick').mockImplementation(() => {
          throw new Error('boom');
        });
        // If the handler re-threw, this `emit` would propagate. The
        // assertion below is the "no throw" side-effect.
        expect(() => process.emit('SIGUSR1', 'SIGUSR1')).not.toThrow();
      });

      it('does not write to stderr on tick() throw when KIMI_CRON_DEBUG is unset', () => {
        if (process.platform === 'win32') return;
        // KIMI_CRON_DEBUG intentionally NOT set in this test.

        const writeSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        try {
          vi.spyOn(cron, 'tick').mockImplementation(() => {
            throw new Error('silent-boom');
          });
          process.emit('SIGUSR1', 'SIGUSR1');
          // No cron/service line was emitted because debug is off.
          const calls = writeSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((s) => /cron\/service/.test(s))).toBe(false);
        } finally {
          writeSpy.mockRestore();
        }
      });

      it('stop() removes the SIGUSR1 listener (no leak)', async () => {
        if (process.platform === 'win32') return;

        // Constructor auto-starts, which binds SIGUSR1 under KIMI_CRON_MANUAL_TICK=1.
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
        await cron.stop();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);
      });

      it('start() is idempotent — second call does not double-bind', async () => {
        if (process.platform === 'win32') return;

        // Constructor already calls start() once; an explicit second
        // call must not stack a handler.
        await cron.start();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
      });
    });

    describe('manual tick debug logging', () => {
      let ctx: TestAgentContext;
      let cron: ISessionCronService;

      beforeEach(() => {
        vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
        vi.stubEnv('KIMI_CRON_DEBUG', '1');
        ctx = createTestAgent(cronServices());
        cron = ctx.get(ISessionCronService);
      });

      afterEach(async () => {
        await ctx.dispose();
      });

      it('logs swallowed tick() throws to stderr when KIMI_CRON_DEBUG=1', () => {
        if (process.platform === 'win32') return;

        const writeSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        try {
          vi.spyOn(cron, 'tick').mockImplementation(() => {
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
        }
      });
    });

    describe('manual tick disabled', () => {
      let ctx: TestAgentContext;
      let cron: ISessionCronService;

      beforeEach(() => {
        ctx = createTestAgent(cronServices());
        cron = ctx.get(ISessionCronService);
      });

      afterEach(async () => {
        await ctx.dispose();
      });

      it('does not bind when KIMI_CRON_MANUAL_TICK is unset', async () => {
        if (process.platform === 'win32') return;

        const before = process.listenerCount('SIGUSR1');
        await cron.start();
        expect(process.listenerCount('SIGUSR1')).toBe(before);
      });
    });
  });
});
