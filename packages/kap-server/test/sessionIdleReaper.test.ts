import type { ISessionManager, ISessionScopeHandle } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_IDLE_RECLAIM_MS,
  SESSION_IDLE_RECLAIM_ENV,
  SessionIdleReaper,
  resolveSessionIdleReclaimMs,
} from '../src/services/sessionIdleReaper';
import { ManagedIdleExit } from '../src/services/managedIdleExit';
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

  it('stops visiting sessions after close', async () => {
    const sessions = fakeSessions(['s1', 's2']);
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
    const closing = reaper.close();
    release();
    await Promise.all([first, closing]);
    expect(sessions.calls).toEqual(['s1']);
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

describe('ManagedIdleExit', () => {
  function setup(
    state: { sessions: number; connections: number },
    closeIfIdle: (id: string) => Promise<boolean> = async () => false,
  ) {
    let now = 0;
    const onIdle = vi.fn();
    const exit = new ManagedIdleExit(
      {
        list: () =>
          Array.from({ length: state.sessions }, (_, index) => ({ id: `s${index}` }) as ISessionScopeHandle),
        closeIfIdle,
      },
      { size: () => state.connections },
      1000,
      onIdle,
      () => now,
    );
    return { exit, onIdle, advance: (ms: number) => (now += ms) };
  }

  it('fires once after the idle window with no sessions and no connections', async () => {
    const { exit, onIdle, advance } = setup({ sessions: 0, connections: 0 });
    advance(999);
    await exit.sweep();
    expect(onIdle).not.toHaveBeenCalled();
    advance(1);
    await exit.sweep();
    await exit.sweep();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('restarts the idle window while a session or connection is live', async () => {
    const state = { sessions: 1, connections: 0 };
    const { exit, onIdle, advance } = setup(state);
    advance(5000);
    await exit.sweep();
    state.sessions = 0;
    state.connections = 1;
    advance(5000);
    await exit.sweep();
    state.connections = 0;
    advance(999);
    await exit.sweep();
    expect(onIdle).not.toHaveBeenCalled();
    advance(1);
    await exit.sweep();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('unloads idle sessions before measuring the idle window', async () => {
    const state = { sessions: 1, connections: 0 };
    const { exit, onIdle, advance } = setup(state, async () => {
      state.sessions = 0;
      return true;
    });
    await exit.sweep();
    expect(onIdle).not.toHaveBeenCalled();
    advance(1000);
    await exit.sweep();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
