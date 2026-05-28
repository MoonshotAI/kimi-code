/**
 * Tests for `agent/cron/manager.ts` P1.8 affordances: the
 * `KIMI_CRON_MANUAL_TICK=1` env disables the auto-tick interval and,
 * in the same gate, binds SIGUSR1 to a no-throw `tick()` for benches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import { createAgentStub, createClocks } from './harness/stub';

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

    it('logs swallowed tick() throws to stderr when KIMI_CRON_DEBUG=1', async () => {
      if (process.platform === 'win32') return;
      vi.stubEnv('KIMI_CRON_DEBUG', '1');

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        manager.start();
        vi.spyOn(manager, 'tick').mockImplementation(() => {
          throw new Error('debug-boom');
        });
        process.emit('SIGUSR1', 'SIGUSR1');
        expect(writeSpy).toHaveBeenCalled();
        const calls = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(calls.some((s) => /cron\/manager.*SIGUSR1/.test(s))).toBe(true);
        expect(calls.some((s) => s.includes('debug-boom'))).toBe(true);
      } finally {
        writeSpy.mockRestore();
        await manager.stop();
      }
    });

    it('does not write to stderr on tick() throw when KIMI_CRON_DEBUG is unset', async () => {
      if (process.platform === 'win32') return;
      // KIMI_CRON_DEBUG intentionally NOT set in this test.

      const stub = createAgentStub();
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      const writeSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        manager.start();
        vi.spyOn(manager, 'tick').mockImplementation(() => {
          throw new Error('silent-boom');
        });
        process.emit('SIGUSR1', 'SIGUSR1');
        // No cron/manager line was emitted because debug is off.
        const calls = writeSpy.mock.calls.map((c) => String(c[0]));
        expect(calls.some((s) => /cron\/manager/.test(s))).toBe(false);
      } finally {
        writeSpy.mockRestore();
        await manager.stop();
      }
    });

    it('stop() removes the SIGUSR1 listener (no leak)', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const before = process.listenerCount('SIGUSR1');
      // Constructor auto-starts, which binds SIGUSR1 under KIMI_CRON_MANUAL_TICK=1.
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      expect(process.listenerCount('SIGUSR1')).toBe(before + 1);
      await manager.stop();
      expect(process.listenerCount('SIGUSR1')).toBe(before);
    });

    it('start() is idempotent — second call does not double-bind', async () => {
      if (process.platform === 'win32') return;

      const stub = createAgentStub();
      const before = process.listenerCount('SIGUSR1');
      // Constructor already calls start() once; an explicit second
      // call must not stack a handler.
      const manager = new CronManager(stub.agent, { pollIntervalMs: null });
      try {
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
