import type { ISessionManager, ISessionScopeHandle } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_IDLE_RECLAIM_MS,
  SESSION_IDLE_RECLAIM_ENV,
  SessionIdleReaper,
  resolveSessionIdleReclaimMs,
} from '../src/services/sessionIdleReaper';
import type { ServerLogger } from '../src/services/pinoLoggerService';

function fakeSessions(ids: readonly string[]) {
  const calls: string[] = [];
  const fake: {
    calls: string[];
    impl: (sessionId: string) => Promise<boolean>;
    manager: Pick<ISessionManager, 'list' | 'closeIfIdle'>;
  } = {
    calls,
    impl: async (_sessionId: string) => true,
    manager: {
      list: () => ids.map((id) => ({ id }) as unknown as ISessionScopeHandle),
      closeIfIdle: async (sessionId: string) => {
        calls.push(sessionId);
        return fake.impl(sessionId);
      },
    } satisfies Pick<ISessionManager, 'list' | 'closeIfIdle'>,
  };
  return fake;
}

function fakeLogger(): Pick<ServerLogger, 'info' | 'warn'> {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Pick<ServerLogger, 'info' | 'warn'>;
}

describe('SessionIdleReaper', () => {
  it('resolves the idle timeout from the environment', () => {
    expect(resolveSessionIdleReclaimMs({})).toBe(DEFAULT_SESSION_IDLE_RECLAIM_MS);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '5000' })).toBe(5000);
    expect(resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: '0' })).toBe(0);
  });

  it('throws for negative, non-integer, or non-numeric values', () => {
    for (const raw of ['-1', '0.5', 'nope']) {
      expect(() => resolveSessionIdleReclaimMs({ [SESSION_IDLE_RECLAIM_ENV]: raw })).toThrow(
        /KIMI_CODE_SESSION_IDLE_RECLAIM_MS.*non-negative integer/,
      );
    }
  });

  it('does not re-enter a running sweep, and close waits for it', async () => {
    vi.useFakeTimers();
    try {
      const sessions = fakeSessions(['s1']);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      sessions.impl = async () => {
        await gate;
        return true;
      };
      const reaper = new SessionIdleReaper(sessions.manager, fakeLogger(), 1000);
      const first = reaper.sweep();
      expect(reaper.sweep()).toBe(first);
      reaper.start();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toEqual(['s1']);
      let closed = false;
      const closing = reaper.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toEqual(['s1']);
      expect(closed).toBe(false);
      release();
      await Promise.all([first, closing]);
      expect(closed).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.calls).toEqual(['s1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
