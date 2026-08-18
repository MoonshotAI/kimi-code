import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { createTestAgent, cronServices, type TestAgentContext } from '../../harness';

const WALL_ANCHOR = 1_700_000_000_000;

interface ClockHarness {
  advance(ms: number): void;
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
  return vi.spyOn(prompt, 'inject').mockImplementation(async (_message: ContextMessage) => undefined);
}

describe('SessionCronService — P1.8 manual tick + SIGUSR1', () => {
  beforeEach(() => {
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
      ctx.announceMain();
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

      await new Promise((r) => setTimeout(r, 50));
      expect(steerSpy).toHaveBeenCalledTimes(0);

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
      vi.useFakeTimers();
      vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '50');
      harness = createClocks();
      ctx = createTestAgent(cronServices());
      ctx.announceMain();
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
      harness.advance(6 * 60_000);
      await vi.advanceTimersByTimeAsync(60);

      expect(steerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('SIGUSR1', () => {
    describe('manual tick enabled', () => {
      let ctx: TestAgentContext;
      let cron: ISessionCronService;
      let listenerCountBeforeCreate: number;

      beforeEach(async () => {
        vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
        listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
        ctx = createTestAgent(cronServices());
        ctx.announceMain();
        await ctx.restorePersisted();
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
        expect(() => process.emit('SIGUSR1', 'SIGUSR1')).not.toThrow();
      });

      it('does not write to stderr on tick() throw when KIMI_CRON_DEBUG is unset', () => {
        if (process.platform === 'win32') return;
        const writeSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation(() => true);
        try {
          vi.spyOn(cron, 'tick').mockImplementation(() => {
            throw new Error('silent-boom');
          });
          process.emit('SIGUSR1', 'SIGUSR1');
          const calls = writeSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((s) => /cron\/service/.test(s))).toBe(false);
        } finally {
          writeSpy.mockRestore();
        }
      });

      it('stop() removes the SIGUSR1 listener (no leak)', async () => {
        if (process.platform === 'win32') return;

        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
        await cron.stop();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);
      });

      it('start() is idempotent — second call does not double-bind', async () => {
        if (process.platform === 'win32') return;

        await cron.start();
        expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
      });
    });

    describe('manual tick debug logging', () => {
      let ctx: TestAgentContext;
      let cron: ISessionCronService;

      beforeEach(async () => {
        vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
        vi.stubEnv('KIMI_CRON_DEBUG', '1');
        ctx = createTestAgent(cronServices());
        ctx.announceMain();
        await ctx.restorePersisted();
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
          expect(calls.some((s) => /cron\/session.*SIGUSR1/.test(s))).toBe(
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
        ctx.announceMain();
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
