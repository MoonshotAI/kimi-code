import { describe, expect, it, vi } from 'vitest';
import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

import { createMainTranscriptPool } from '../src/composables/useMainTranscripts';

function page(agentId: string, seq = 3) {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
    seq,
    agentId,
  };
}

function makePool(maxResidentSessions = 4) {
  const subscribeTranscript = vi.fn();
  const unsubscribeTranscript = vi.fn();
  const getSessionTranscript = vi.fn(async (_sessionId: string) => page('main'));
  const pool = createMainTranscriptPool({
    api: { getSessionTranscript } as unknown as KimiWebApi,
    connectEventsIfNeeded: vi.fn(),
    getEventConnection: () =>
      ({ subscribeTranscript, unsubscribeTranscript }) as unknown as KimiEventConnection,
    maxResidentSessions,
  });
  return { pool, subscribeTranscript, unsubscribeTranscript, getSessionTranscript };
}

describe('createMainTranscriptPool', () => {
  it('cold-loads the baseline then subscribes with the page seq', async () => {
    const { pool, subscribeTranscript } = makePool();

    pool.activate('s1');
    expect(subscribeTranscript).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'main', 3);
    });
  });

  it('keeps the subscription when the session is deactivated (background retention)', async () => {
    const { pool, subscribeTranscript, unsubscribeTranscript } = makePool();

    pool.activate('s1');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());
    pool.deactivate('s1');

    expect(unsubscribeTranscript).not.toHaveBeenCalled();
    expect(pool.subscribedSessions.has('s1')).toBe(true);
  });

  it('evicts and detaches the oldest session beyond the resident cap', async () => {
    const { pool, subscribeTranscript, unsubscribeTranscript } = makePool(2);

    pool.activate('s1');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'main', 3));
    pool.activate('s2');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s2', 'main', 3));
    pool.activate('s3');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s3', 'main', 3));

    expect(unsubscribeTranscript).toHaveBeenCalledWith('s1', ['main']);
    expect(pool.subscribedSessions.has('s1')).toBe(false);
    expect(pool.subscribedSessions.has('s2')).toBe(true);
    expect(pool.subscribedSessions.has('s3')).toBe(true);
  });

  it('re-subscribing an evicted session cold-loads again', async () => {
    const { pool, subscribeTranscript, getSessionTranscript } = makePool(1);

    pool.activate('s1');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'main', 3));
    pool.activate('s2');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s2', 'main', 3));
    expect(pool.subscribedSessions.has('s1')).toBe(false);

    getSessionTranscript.mockClear();
    pool.activate('s1');
    await vi.waitFor(() => expect(getSessionTranscript).toHaveBeenCalled());
  });

  it('re-anchors over REST instead of wiping the window on an items-empty reset', async () => {
    const { pool, subscribeTranscript, getSessionTranscript } = makePool();

    pool.activate('s1');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s1', 'main', 3));

    // Simulate the server's baseline reset landing after the REST page
    // already populated the channel.
    const entry = pool.getEntry('s1')!;
    expect(entry.channel.snapshot.items.length).toBe(0); // page() fixture ships no items
    entry.channel.receiveReset({ ...page('main'), items: [{
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    }] } as never, 3);
    expect(entry.channel.snapshot.items.length).toBe(1);

    getSessionTranscript.mockClear();
    pool.receiveReset('s1', page('main') as never, 4);

    expect(entry.channel.snapshot.items.length).toBe(1);
    // The re-anchor now rides the capped backoff (a down REST must not spin
    // a tight REST/WS loop) — it fires within ~2s, not immediately.
    await vi.waitFor(() => expect(getSessionTranscript).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('orders same-millisecond activations strictly by visit sequence', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { pool, subscribeTranscript } = makePool(2);

      pool.activate('s1');
      pool.activate('s2');
      pool.activate('s3');

      // A wall-clock tie must never evict the just-activated session: the
      // monotonic visit sequence makes s1 the oldest regardless.
      expect(pool.getEntry('s1')).toBeUndefined();
      expect(pool.getEntry('s2')).toBeDefined();
      expect(pool.getEntry('s3')).toBeDefined();
      await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalledWith('s3', 'main', 3));
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgetSession detaches and drops the entry', async () => {
    const { pool, subscribeTranscript, unsubscribeTranscript } = makePool();

    pool.activate('s1');
    await vi.waitFor(() => expect(subscribeTranscript).toHaveBeenCalled());
    pool.forgetSession('s1');

    expect(unsubscribeTranscript).toHaveBeenCalledWith('s1', ['main']);
    expect(pool.getEntry('s1')).toBeUndefined();
  });

  it('retries a failed first read inside the pool on a growing capped backoff', async () => {
    vi.useFakeTimers();
    try {
      const { pool, getSessionTranscript } = makePool();
      let failures = 0;
      getSessionTranscript.mockImplementation(async () => {
        failures += 1;
        if (failures <= 2) throw new Error('network down');
        return page('main');
      });

      pool.activate('s1');
      await vi.advanceTimersByTimeAsync(0);
      // The failed first read evicts the entry (baseline waiters resolve).
      expect(pool.getEntry('s1')).toBeUndefined();
      expect(getSessionTranscript).toHaveBeenCalledTimes(1);

      // The pool-side retry fires at +2s — and not before.
      await vi.advanceTimersByTimeAsync(1999);
      expect(getSessionTranscript).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSessionTranscript).toHaveBeenCalledTimes(2);
      expect(pool.getEntry('s1')).toBeUndefined();

      // The attempt counter survives the entry's eviction: the NEXT retry
      // waits ~4s, not another 2s — a recreated entry must not restart the
      // backoff at its first interval.
      await vi.advanceTimersByTimeAsync(3999);
      expect(getSessionTranscript).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSessionTranscript).toHaveBeenCalledTimes(3);

      // The third read succeeds: the baseline loads and the retry loop stops.
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getEntry('s1')?.baselineLoaded).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getSessionTranscript).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the first-read retry once the session is deactivated or forgotten', async () => {
    vi.useFakeTimers();
    try {
      const { pool, getSessionTranscript } = makePool();
      getSessionTranscript.mockRejectedValue(new Error('network down'));

      pool.activate('s1');
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getEntry('s1')).toBeUndefined();

      // The user switched away: nobody waits on this baseline anymore, so the
      // retry must not keep hammering the failing read.
      pool.deactivate('s1');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getSessionTranscript).toHaveBeenCalledTimes(1);

      // Same for a session torn down while its retry was pending.
      pool.activate('s2');
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getEntry('s2')).toBeUndefined();
      pool.forgetSession('s2');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getSessionTranscript).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces only the FIRST baseline failure — retries just log', async () => {
    vi.useFakeTimers();
    try {
      const onBaselineError = vi.fn();
      const getSessionTranscript = vi.fn(async () => {
        throw new Error('network down');
      });
      const pool = createMainTranscriptPool({
        api: { getSessionTranscript } as unknown as KimiWebApi,
        connectEventsIfNeeded: vi.fn(),
        getEventConnection: () => null,
        onBaselineError,
      });

      pool.activate('s1');
      await vi.advanceTimersByTimeAsync(0);
      expect(onBaselineError).toHaveBeenCalledTimes(1);

      // Two more failed retries: a sustained outage must not re-toast the
      // same warning every interval (pushOperationFailure appends, no dedupe).
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSessionTranscript).toHaveBeenCalledTimes(3);
      expect(onBaselineError).toHaveBeenCalledTimes(1);

      // An explicit re-activate re-arms the notice (fresh user intent).
      pool.activate('s1');
      await vi.advanceTimersByTimeAsync(0);
      expect(onBaselineError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never arms a first-read retry for a session deactivated mid-read', async () => {
    vi.useFakeTimers();
    try {
      const onBaselineError = vi.fn();
      let rejectRead!: (err: Error) => void;
      const getSessionTranscript = vi.fn(
        () => new Promise((_resolve, reject) => { rejectRead = reject; }),
      );
      const pool = createMainTranscriptPool({
        api: { getSessionTranscript } as unknown as KimiWebApi,
        connectEventsIfNeeded: vi.fn(),
        getEventConnection: () => null,
        onBaselineError,
      });

      pool.activate('s1');
      // The user switches away while the first read is still in flight.
      pool.deactivate('s1');
      // The refresh first joins settleOlder (a microtask) — let the read's
      // executor run before rejecting it.
      await vi.advanceTimersByTimeAsync(0);
      rejectRead(new Error('network down'));
      await vi.advanceTimersByTimeAsync(0);

      // The failure still surfaces ONCE — but no retry loop may start: the
      // deactivate ran before any retry state existed, so nothing would ever
      // cancel it.
      expect(onBaselineError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(getSessionTranscript).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lands a reset that arrived mid-refresh AFTER the older REST page', async () => {
    let resolveRead!: (page: unknown) => void;
    const getSessionTranscript = vi.fn(
      () => new Promise((resolve) => { resolveRead = resolve; }),
    );
    const subscribeTranscript = vi.fn();
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(getSessionTranscript).toHaveBeenCalled());

    // The server re-anchors mid-read (reconnect reset carrying the final
    // turn-end): applying it immediately would let the in-flight page
    // overwrite it a moment later.
    const resetTurn = {
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    };
    pool.receiveReset('s1', { ...page('main', 9), items: [resetTurn] } as never, 9);
    expect(pool.getEntry('s1')?.baselineLoaded).toBe(false);

    // The REST page (older, empty) commits first; the buffered reset lands
    // on top of it — the client must not stick on the pre-reset snapshot.
    resolveRead(page('main', 3));
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));
    expect(pool.getEntry('s1')?.channel.snapshot.items).toHaveLength(1);
    expect(subscribeTranscript).toHaveBeenLastCalledWith('s1', 'main', 9);
  });

  it('keeps the CURRENT entry’s armed retry when a dead entry’s late read succeeds', async () => {
    vi.useFakeTimers();
    try {
      const resolvers: Array<(page: unknown) => void> = [];
      const rejecters: Array<(err: Error) => void> = [];
      const getSessionTranscript = vi.fn(
        () => new Promise((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
      );
      const pool = createMainTranscriptPool({
        api: { getSessionTranscript } as unknown as KimiWebApi,
        connectEventsIfNeeded: vi.fn(),
        getEventConnection: () => null,
      });

      // Read #1 hangs; the session is forgotten and re-activated (a fresh
      // entry whose read #2 fails and arms the retry).
      pool.activate('s1');
      pool.forgetSession('s1');
      pool.activate('s1');
      // Let the second read's executor run (settleOlder yields a microtask).
      await vi.advanceTimersByTimeAsync(0);
      rejecters[1]!(new Error('network down'));
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getEntry('s1')).toBeUndefined();

      // The DEAD entry's late success must not clear the armed retry —
      // clearing it would leave no entry AND no retry.
      resolvers[0]!(page('main'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);
      // The retry still fired (read #3).
      expect(getSessionTranscript).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes pool.refreshSession (undo rewind) against a mid-read reset', async () => {
    let resolveRead!: (page: unknown) => void;
    const getSessionTranscript = vi.fn(
      () => new Promise((resolve) => { resolveRead = resolve; }),
    );
    const subscribeTranscript = vi.fn();
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(getSessionTranscript).toHaveBeenCalled());
    resolveRead(page('main', 3));
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));

    // The rewind's pool-serialized refresh starts (its read hangs).
    const refresh = pool.refreshSession('s1');
    await vi.waitFor(() => expect(getSessionTranscript).toHaveBeenCalledTimes(2));

    // A newer reset lands mid-read: it must be buffered and land AFTER the
    // older page, not be overwritten by it.
    const resetTurn = {
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    };
    pool.receiveReset('s1', { ...page('main', 9), items: [resetTurn] } as never, 9);
    resolveRead(page('main', 3));
    await refresh;

    expect(pool.getEntry('s1')?.channel.snapshot.items).toHaveLength(1);
  });

  it('backs off an items-empty reset over an already-loaded baseline', async () => {
    vi.useFakeTimers();
    try {
      const getSessionTranscript = vi.fn(async () => page('main'));
      const pool = createMainTranscriptPool({
        api: { getSessionTranscript } as unknown as KimiWebApi,
        connectEventsIfNeeded: vi.fn(),
        getEventConnection: () => null,
      });

      pool.activate('s1');
      await vi.advanceTimersByTimeAsync(0);
      expect(pool.getEntry('s1')?.baselineLoaded).toBe(true);
      const callsAtBaseline = getSessionTranscript.mock.calls.length;

      // The server's cursorless answer after a failed gap-refresh: an
      // immediate re-read would spin a tight REST/WS loop while the REST is
      // down — the retry must ride the capped backoff instead.
      pool.receiveReset('s1', page('main') as never, 5);
      expect(getSessionTranscript).toHaveBeenCalledTimes(callsAtBaseline);
      await vi.advanceTimersByTimeAsync(1999);
      expect(getSessionTranscript).toHaveBeenCalledTimes(callsAtBaseline);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSessionTranscript).toHaveBeenCalledTimes(callsAtBaseline + 1);

      // The successful gap-refresh clears the retry counter.
      expect(pool.getEntry('s1')?.emptyResetRetries).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('buffers a reset arriving during a history pagination until it settles', async () => {
    const olderPage = { ...page('main', 2), hasMoreOlder: false };
    let resolveOlder!: (page: unknown) => void;
    const baselineTurn = {
      kind: 'turn', turnId: 't0', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    };
    const getSessionTranscript = vi.fn(async (sessionId: string, query?: { beforeTurn?: string }) =>
      query?.beforeTurn !== undefined
        ? new Promise((resolve) => { resolveOlder = resolve; })
        : { ...page('main', 3), items: [baselineTurn], hasMoreOlder: true },
    );
    const subscribeTranscript = vi.fn();
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));

    const entry = pool.getEntry('s1')!;
    const older = entry.channel.loadOlder();
    await vi.waitFor(() => expect(entry.channel.loadingOlder).toBe(true));

    // A reconnect reset lands mid-pagination: the older page must not
    // overwrite its newer meta/tasks — buffer until the page commits.
    const resetTurn = {
      kind: 'turn', turnId: 't1', ordinal: 9, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    };
    pool.receiveReset('s1', { ...page('main', 9), items: [resetTurn] } as never, 9);
    // Buffered: the snapshot still shows the baseline turn, not the reset's.
    expect(
      entry.channel.snapshot.items.map((item) => (item.kind === 'turn' ? item.turnId : '')),
    ).toEqual(['t0']);

    resolveOlder(olderPage);
    await older;
    await vi.waitFor(() =>
      expect(
        entry.channel.snapshot.items.map((item) => (item.kind === 'turn' ? item.turnId : '')),
      ).toEqual(['t1']),
    );
  });

  it('joins an in-flight history pagination before refreshing', async () => {
    const olderPage = { ...page('main', 2), hasMoreOlder: false };
    let resolveOlder!: (page: unknown) => void;
    const baselineTurn = {
      kind: 'turn', turnId: 't0', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'hi', steps: [],
    };
    const seen: string[] = [];
    const getSessionTranscript = vi.fn(async (sessionId: string, query?: { beforeTurn?: string }) => {
      if (query?.beforeTurn !== undefined) {
        seen.push('older');
        return new Promise((resolve) => { resolveOlder = resolve; });
      }
      seen.push('refresh');
      return { ...page('main', 5), items: [baselineTurn], hasMoreOlder: true };
    });
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () => null,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));

    const entry = pool.getEntry('s1')!;
    const older = entry.channel.loadOlder();
    await vi.waitFor(() => expect(entry.channel.loadingOlder).toBe(true));

    // The refresh must not START its own read until the older page commits —
    // the older response landing after it would overwrite the fresh state.
    const refresh = pool.refreshSession('s1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(['refresh', 'older']);

    resolveOlder(olderPage);
    await older;
    await refresh;
    expect(seen).toEqual(['refresh', 'older', 'refresh']);
  });

  it('lands ops queued behind a pagination-held reset AFTER the reset, in WS order', async () => {
    // During history pagination a non-empty reset is buffered; ops arriving
    // behind it must land AFTER the reset commits — replaying them first
    // (the channel's own buffer) and then writing the older reset back
    // would cover the fresh deltas.
    const subscribeTranscript = vi.fn();
    const unsubscribeTranscript = vi.fn();
    const baselineTurn = {
      kind: 'turn', turnId: 't_old', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'old', steps: [],
    };
    let resolveOlder!: (page: unknown) => void;
    const getSessionTranscript = vi.fn(async (sessionId: string, query?: { beforeTurn?: string }) => {
      if (query?.beforeTurn !== undefined) {
        return new Promise((resolve) => { resolveOlder = resolve; });
      }
      return { ...page('main', 3), items: [baselineTurn], hasMoreOlder: true };
    });
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript, unsubscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));
    const entry = pool.getEntry('s1')!;
    void entry.channel.loadOlder();
    await vi.waitFor(() => expect(entry.channel.loadingOlder).toBe(true));

    // The reset lands mid-pagination (buffered); a newer op arrives behind it.
    const resetTurn = {
      kind: 'turn', turnId: 't_reset', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'reset', steps: [],
    };
    pool.receiveReset('s1', { ...page('main', 10), items: [resetTurn], hasMoreOlder: false } as never, 10);
    pool.applyOps('s1', [{
      op: 'turn.upsert',
      turn: {
        kind: 'turn', turnId: 't_new', ordinal: 2, state: 'running',
        origin: { kind: 'user' }, steps: [],
      },
    }] as never, 11);
    // Not applied yet — the op waits behind the buffered reset.
    expect(
      entry.channel.snapshot.items.some((item) => item.kind === 'turn' && item.turnId === 't_new'),
    ).toBe(false);

    resolveOlder({ ...page('main', 4), items: [], hasMoreOlder: false });
    await vi.waitFor(() => {
      const ids = entry.channel.snapshot.items
        .filter((item) => item.kind === 'turn')
        .map((item) => item.turnId);
      // The reset committed FIRST, then the queued op landed on top of it.
      expect(ids).toEqual(['t_reset', 't_new']);
    });
    expect(entry.channel.seq).toBe(11);
  });

  it('drops ops queued behind a SUPERSEDED pending reset', async () => {
    // reset A, ops A1, reset B arrive while a read is in flight: B supersedes
    // A, and A1 (which predates B) must NOT land after B — it would
    // resurrect transcript state the newer reset just cleared. seq is
    // optional on this contract, so no seq filter can save this.
    const subscribeTranscript = vi.fn();
    const unsubscribeTranscript = vi.fn();
    const baselineTurn = {
      kind: 'turn', turnId: 't_old', ordinal: 1, state: 'completed',
      origin: { kind: 'user' }, prompt: 'old', steps: [],
    };
    let resolveOlder!: (page: unknown) => void;
    const getSessionTranscript = vi.fn(async (sessionId: string, query?: { beforeTurn?: string }) => {
      if (query?.beforeTurn !== undefined) {
        return new Promise((resolve) => { resolveOlder = resolve; });
      }
      return { ...page('main', 3), items: [baselineTurn], hasMoreOlder: true };
    });
    const pool = createMainTranscriptPool({
      api: { getSessionTranscript } as unknown as KimiWebApi,
      connectEventsIfNeeded: vi.fn(),
      getEventConnection: () =>
        ({ subscribeTranscript, unsubscribeTranscript }) as unknown as KimiEventConnection,
    });

    pool.activate('s1');
    await vi.waitFor(() => expect(pool.getEntry('s1')?.baselineLoaded).toBe(true));
    const entry = pool.getEntry('s1')!;
    void entry.channel.loadOlder();
    await vi.waitFor(() => expect(entry.channel.loadingOlder).toBe(true));

    const turnOf = (turnId: string, ordinal: number) => ({
      kind: 'turn', turnId, ordinal, state: 'completed',
      origin: { kind: 'user' }, prompt: turnId, steps: [],
    });
    const opsOf = (turnId: string, ordinal: number) => [{
      op: 'turn.upsert',
      turn: { kind: 'turn', turnId, ordinal, state: 'running', origin: { kind: 'user' }, steps: [] },
    }];
    pool.receiveReset('s1', { ...page('main'), items: [turnOf('t_A', 1)] } as never);
    pool.applyOps('s1', opsOf('t_A1', 2) as never);
    pool.receiveReset('s1', { ...page('main'), items: [turnOf('t_B', 1)] } as never);
    pool.applyOps('s1', opsOf('t_B1', 2) as never);

    resolveOlder({ ...page('main', 4), items: [], hasMoreOlder: false });
    await vi.waitFor(() => {
      const ids = entry.channel.snapshot.items
        .filter((item) => item.kind === 'turn')
        .map((item) => item.turnId);
      // B landed, then only the ops queued BEHIND B — A1 stays buried.
      expect(ids).toEqual(['t_B', 't_B1']);
    });
  });
});
