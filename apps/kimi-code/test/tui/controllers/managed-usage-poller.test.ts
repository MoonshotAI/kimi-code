import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createManagedUsagePoller,
  type ManagedUsagePollerOptions,
} from '#/tui/controllers/managed-usage-poller';
import type { AppState, ManagedUsageSnapshot } from '#/tui/types';

type Harness = ManagedUsagePollerOptions['harness'];
type GetManagedUsage = Harness['auth']['getManagedUsage'];
type WireResult = Awaited<ReturnType<GetManagedUsage>>;

function wireRow(overrides: {
  name?: string;
  window?: { duration: number; unit: 'minute' | 'hour' | 'day' | 'week' };
  used: number;
  limit: number;
  resetAt?: string;
}): WireResult extends { kind: 'ok'; limits: Array<infer L> } ? L : never {
  return overrides as never;
}

function wireOk(rows: ReadonlyArray<ReturnType<typeof wireRow>>, summary: ReturnType<typeof wireRow> | null = null): WireResult {
  return {
    kind: 'ok',
    summary,
    limits: [...rows],
    extraUsage: null,
  } as never;
}

function wireError(message = 'boom'): WireResult {
  return { kind: 'error', message } as never;
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    version: '1.0.0',
    workDir: '/tmp',
    additionalDirs: [],
    sessionId: 's1',
    sessionTitle: null,
    model: 'kimi-k2',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    theme: 'dark',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    availableModels: {
      'kimi-k2': { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 262144 },
      'external-model': { provider: 'external:openai', model: 'external-model', maxContextSize: 8192 },
    },
    availableProviders: {},
    mcpServersSummary: null,
    ...overrides,
  };
}

function createHarness(getManagedUsage: ReturnType<typeof vi.fn>): Harness {
  return { auth: { getManagedUsage } } as never;
}

function lastSnapshot(updates: Array<ManagedUsageSnapshot | null>): ManagedUsageSnapshot | null {
  return updates[updates.length - 1] ?? null;
}

async function tick(): Promise<void> {
  // Advance fake time without scheduling any timers — this drains pending
  // microtasks so the in-flight fetch's promise chain resolves.
  await vi.advanceTimersByTimeAsync(0);
}

describe('ManagedUsagePoller', () => {
  let getManagedUsage: ReturnType<typeof vi.fn>;
  let state: AppState;
  let updates: Array<ManagedUsageSnapshot | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    getManagedUsage = vi.fn();
    state = makeState();
    updates = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function startPoller(overrides: Partial<ManagedUsagePollerOptions> = {}) {
    const poller = createManagedUsagePoller({
      harness: createHarness(getManagedUsage),
      getState: () => state,
      onUpdate: (snapshot) => updates.push(snapshot),
      ...overrides,
    });
    return poller;
  }

  it('publishes the first snapshot for a managed provider', async () => {
    getManagedUsage.mockResolvedValue(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 30, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    poller.dispose();

    const snap = lastSnapshot(updates) as ManagedUsageSnapshot;
    expect(snap).not.toBeNull();
    expect(snap.limits).toHaveLength(1);
    expect(snap.limits[0]?.label).toBe('5h limit');
    expect(snap.limits[0]?.used).toBe(30);
    expect(snap.limits[0]?.limit).toBe(100);
    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(getManagedUsage).toHaveBeenCalledWith('managed:kimi-code');
  });

  it('drops any published snapshot when the provider stops being managed', async () => {
    getManagedUsage.mockResolvedValueOnce(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 10, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    expect(lastSnapshot(updates)).not.toBeNull();

    state = makeState({ model: 'external-model' });
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)).toBeNull();
  });

  it('refetches immediately after switching back from a non-managed provider', async () => {
    state = makeState({ model: 'external-model' });
    getManagedUsage.mockResolvedValue(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 1, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    expect(getManagedUsage).not.toHaveBeenCalled();

    state = makeState({ model: 'kimi-k2' });
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(getManagedUsage).toHaveBeenCalledTimes(1);
    expect(lastSnapshot(updates)).not.toBeNull();
  });

  it('does not republish a snapshot with identical quota content', async () => {
    const row = wireRow({ window: { duration: 5, unit: 'hour' }, used: 30, limit: 100 });
    getManagedUsage.mockResolvedValue(wireOk([row]));
    const poller = startPoller();
    await tick();

    const before = updates.length;
    // Wait past the throttle so the next interval tick will fetch again.
    await vi.advanceTimersByTimeAsync(70_000);
    poller.dispose();

    expect(getManagedUsage.mock.calls.length).toBeGreaterThan(1);
    expect(updates.length).toBe(before); // identical snapshot suppressed
  });

  it('keeps the previous snapshot when a fetch returns an error', async () => {
    getManagedUsage.mockResolvedValueOnce(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 30, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    const before = lastSnapshot(updates);

    getManagedUsage.mockResolvedValueOnce(wireError('server down'));
    await vi.advanceTimersByTimeAsync(70_000);
    poller.dispose();

    expect(lastSnapshot(updates)).toBe(before);
  });

  it('discards an in-flight response when a newer refresh supersedes it', async () => {
    let resolveFirst!: (value: WireResult) => void;
    const firstResponse = new Promise<WireResult>((res) => {
      resolveFirst = res;
    });
    getManagedUsage.mockReturnValueOnce(firstResponse);

    const poller = startPoller();
    await tick();

    // Provider switches mid-flight (e.g. user picks another managed model).
    state = makeState({ model: 'external-model' });
    poller.refreshNow();
    await tick();

    // The in-flight managed response lands — must NOT republish into the
    // now non-managed state.
    resolveFirst(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 99, limit: 100 })]),
    );
    await tick();
    poller.dispose();

    expect(lastSnapshot(updates)).toBeNull();
  });

  it('lets refreshNow() bypass the throttle without waiting for the interval', async () => {
    getManagedUsage.mockResolvedValue(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 1, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    const initialCalls = getManagedUsage.mock.calls.length;

    // Way before the 60s interval; without refreshNow() the next fetch would
    // be skipped.
    await vi.advanceTimersByTimeAsync(5_000);
    poller.refreshNow();
    await tick();
    poller.dispose();

    expect(getManagedUsage.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not publish after dispose', async () => {
    getManagedUsage.mockResolvedValue(
      wireOk([wireRow({ window: { duration: 5, unit: 'hour' }, used: 1, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    const before = updates.length;
    poller.dispose();

    await vi.advanceTimersByTimeAsync(70_000);

    expect(updates.length).toBe(before);
  });

  it('honors the weekly window shorthand', async () => {
    getManagedUsage.mockResolvedValue(
      wireOk([wireRow({ window: { duration: 1, unit: 'week' }, used: 50, limit: 100 })]),
    );
    const poller = startPoller();
    await tick();
    poller.dispose();

    const snap = lastSnapshot(updates) as ManagedUsageSnapshot;
    expect(snap.limits[0]?.label).toBe('Weekly limit');
  });
});