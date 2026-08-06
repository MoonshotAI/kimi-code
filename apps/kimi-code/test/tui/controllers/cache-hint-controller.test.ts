import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CacheHintController,
  type CacheHintHost,
} from '#/tui/controllers/cache-hint-controller';
import type { CacheHintConfig } from '#/utils/cache-hint-config';

const peekMock = vi.fn<() => CacheHintConfig | undefined>(() => undefined);
const getMock = vi.fn(async (): Promise<CacheHintConfig | undefined> => undefined);

vi.mock('#/utils/cache-hint-config', () => ({
  peekCacheHintConfig: () => peekMock(),
  getCacheHintConfig: (...args: unknown[]) => getMock(...(args as [])),
  refreshCacheHintConfigInBackground: () => undefined,
  resetCacheHintConfigCache: () => undefined,
}));

const CONFIG: CacheHintConfig = {
  version: 1,
  config: { 'kimi-k2': { min_tokens_to_hint: 100000, cache_duration: 600 } },
};

function makeHost(
  overrides: {
    session?: unknown;
    appState?: Record<string, unknown>;
    createNewSessionFails?: boolean;
  } = {},
) {
  const state = {
    activeDialog: null as string | null,
    appState: {
      model: 'k2',
      availableModels: { k2: { model: 'kimi-k2', provider: 'managed:kimi-code' } },
      availableProviders: { 'managed:kimi-code': { oauth: { key: 'kimi-code' } } },
      sessionId: 's1',
      streamingPhase: 'idle',
      isCompacting: false,
      contextTokens: 150000,
      cacheExpiryHint: true,
      ...overrides.appState,
    },
  };
  const host: CacheHintHost = {
    engineV2: true,
    harness: { auth: { getCachedAccessToken: vi.fn(async () => 'tok') } } as never,
    session: (overrides.session ?? { id: 's1' }) as never,
    state: state as never,
    track: vi.fn(),
    setAppState: vi.fn((patch) => Object.assign(state.appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    showError: vi.fn(),
    createNewSession: vi.fn(async () => {
      if (overrides.createNewSessionFails !== true) state.appState.sessionId = 's2';
    }),
    sendNormalUserInput: vi.fn(async () => undefined),
  };
  return { host, state };
}

function resumeSession(replayTimes: number[], tokenCount: number, updatedAt = 0) {
  return {
    id: 's1',
    summary: { updatedAt },
    getResumeState: () => ({
      agents: {
        main: {
          replay: replayTimes.map((time) => ({ type: 'message', time })),
          context: { tokenCount },
        },
      },
    }),
  };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  peekMock.mockReset().mockReturnValue(undefined);
  getMock.mockReset().mockResolvedValue(undefined);
  vi.useRealTimers();
});

describe('CacheHintController scenario 2 (idle submit)', () => {
  it('does not intercept a fresh submit (no activity baseline)', () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(false);
  });

  it('does not intercept when idle for less than the coarse floor', () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(false);
    expect(peekMock).not.toHaveBeenCalled();
  });

  it('does not intercept when the provider is not OAuth-managed', () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost({
      appState: {
        availableProviders: { 'managed:kimi-code': {} }, // apiKey form: no oauth
      },
    });
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(false);
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('does not cold-fetch for providers that can never match a rule', async () => {
    // Config cache cold (peek returns undefined by default): without the
    // applicability gate this submit would be swallowed for a fetch that can
    // never produce a hint.
    const { host } = makeHost({
      appState: {
        availableProviders: { 'managed:kimi-code': {} }, // apiKey form: no oauth
      },
    });
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(false);
    await flush();
    expect(getMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('swallows a cold-cache submit, fetches, and releases when no rule matches', async () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    await flush();
    expect(getMock).toHaveBeenCalled();
    // Fetch resolved without a matching rule → the message is released.
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello', undefined);
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('fetches on a cold-cache submit and shows the dialog when a rule matches', async () => {
    getMock.mockResolvedValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });
    expect(host.track).toHaveBeenCalledWith(
      'cache_hint_shown',
      expect.objectContaining({ scene: 'idle' }),
    );
    vi.restoreAllMocks();
  });

  it('serializes cold-cache submits so they keep their order', async () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);

    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    expect(controller.maybeInterceptOnSubmit('world')).toBe(true);
    await flush();
    vi.restoreAllMocks();

    expect(host.sendNormalUserInput).toHaveBeenCalledTimes(2);
    expect(
      (host.sendNormalUserInput as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual(['hello', 'world']);
  });

  it('restores chained submits instead of sending when the dialog is dismissed', async () => {
    getMock.mockResolvedValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);

    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    expect(controller.maybeInterceptOnSubmit('world')).toBe(true);
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B'); // dismiss the first dialog
    await flush();

    // Nothing was sent; both inputs are back in the editor, newline-joined.
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.restoreInputText).toHaveBeenLastCalledWith('hello\nworld');
  });

  it('hands the stashed input back when the session switched during the fetch', async () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    (host as unknown as { session: unknown }).session = { id: 's2' };
    await flush();
    vi.restoreAllMocks();

    expect(host.restoreInputText).toHaveBeenCalledWith('hello');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('releases instead of mounting when a foreground operation started during the fetch', async () => {
    getMock.mockResolvedValue(CONFIG);
    const { host, state } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    // A foreground operation (turn / /compact) kicked off mid-fetch.
    state.appState.streamingPhase = 'waiting';
    await flush();
    vi.restoreAllMocks();

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello', undefined);
  });

  it('intercepts and shows the dialog when all conditions hold', () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);

    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith(
      'cache_hint_shown',
      expect.objectContaining({ scene: 'idle', model: 'k2' }),
    );
    vi.restoreAllMocks();
  });

  it('does not advance the cache baseline at turn begin (the prompt may fail pre-model)', () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    // A send begins a turn but fails before any model request — the expired
    // baseline must survive, so the retry still intercepts.
    controller.onTurnBegin();
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    vi.restoreAllMocks();
  });

  it('does not intercept twice in the same idle cycle', () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    expect(controller.maybeInterceptOnSubmit('again')).toBe(false);
    vi.restoreAllMocks();
  });

  it('resends the stashed input on continue', async () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.maybeInterceptOnSubmit('hello');
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B[B'); // down → new
    dialog.handleInput('\u001B[B'); // down → continue
    dialog.handleInput('\r');
    await flush();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello', undefined);
    expect(host.track).toHaveBeenCalledWith('cache_hint_action', {
      action: 'continue',
      scene: 'idle',
    });
  });

  it('restores the input on Esc without sending', async () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.maybeInterceptOnSubmit('hello');
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B');
    await flush();
    expect(host.restoreInputText).toHaveBeenCalledWith('hello');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('compacts then resends once compaction engages', async () => {
    peekMock.mockReturnValue(CONFIG);
    const compact = vi.fn(async () => undefined);
    const { host, state } = makeHost({ session: { id: 's1', compact } });
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.maybeInterceptOnSubmit('hello');
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\r'); // compact (default)
    // The engine flips isCompacting asynchronously via the started event.
    setTimeout(() => {
      state.appState.isCompacting = true;
    }, 10);
    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello', undefined);
    });
    expect(compact).toHaveBeenCalledWith({});
  });

  it('starts a new session and resends', async () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.maybeInterceptOnSubmit('hello');
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B[B'); // down → new
    dialog.handleInput('\r');
    await flush();
    expect(host.createNewSession).toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello', undefined);
  });

  it('keeps the input when new-session creation fails', async () => {
    peekMock.mockReturnValue(CONFIG);
    const { host, state } = makeHost({ createNewSessionFails: true });
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.maybeInterceptOnSubmit('hello');
    vi.restoreAllMocks();

    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B[B');
    dialog.handleInput('\r');
    await flush();
    expect(state.appState.sessionId).toBe('s1');
    expect(host.restoreInputText).toHaveBeenCalledWith('hello');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});

describe('CacheHintController cache-break detection', () => {
  const u = (inputCacheRead: number) => ({
    inputOther: 100,
    output: 50,
    inputCacheRead,
    inputCacheCreation: 0,
  });

  it('does not judge the first measured step', () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.noteStepUsage(u(10000));
    expect(host.track).not.toHaveBeenCalled();
  });

  it('records cache activity on a completed step, even one without usage', () => {
    peekMock.mockReturnValue(CONFIG);
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    // 20 min later a step completes — the provider round trip refreshed the
    // server-side cache…
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    controller.noteStepUsage(undefined);
    // …so a submit right after is fresh and must not be intercepted.
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(false);
    vi.restoreAllMocks();
  });

  it('reports a drop beyond the ratio and token gates with both usages', () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.noteStepUsage(u(10000));
    controller.noteStepUsage(u(7000));

    expect(host.track).toHaveBeenCalledWith(
      'cache_break_detected',
      expect.objectContaining({
        prev_model: 'k2',
        curr_model: 'k2',
        prev_input_cache_read: 10000,
        curr_input_cache_read: 7000,
        cache_read_drop_ratio: 0.3,
      }),
    );
  });

  it('stays quiet within the ratio gate or under the token threshold', () => {
    const a = makeHost();
    const controllerA = new CacheHintController(a.host);
    controllerA.noteStepUsage(u(100000));
    controllerA.noteStepUsage(u(96000)); // 4% drop — inside the ratio gate
    expect(a.host.track).not.toHaveBeenCalled();

    const b = makeHost();
    const controllerB = new CacheHintController(b.host);
    controllerB.noteStepUsage(u(4000));
    controllerB.noteStepUsage(u(2500)); // drop 1500 ≤ 2000 — under the token threshold
    expect(b.host.track).not.toHaveBeenCalled();
  });

  it('skips unmeasured usage without touching the baseline', () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.noteStepUsage(u(10000));
    controller.noteStepUsage(undefined);
    controller.noteStepUsage({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });
    controller.noteStepUsage(u(5000));
    expect(host.track).toHaveBeenCalledWith(
      'cache_break_detected',
      expect.objectContaining({ prev_input_cache_read: 10000, curr_input_cache_read: 5000 }),
    );
  });

  it('resets the baseline on compaction, but records a mid-session model/effort switch', () => {
    const { host, state } = makeHost();
    const controller = new CacheHintController(host);
    controller.noteStepUsage(u(10000));
    controller.resetCacheBreakBaseline();
    controller.noteStepUsage(u(100)); // post-compaction drop is expected
    expect(host.track).not.toHaveBeenCalled();

    // A model switch busts the cache key — that drop IS the signal to record.
    controller.noteStepUsage(u(10000));
    state.appState.model = 'other-model';
    controller.noteStepUsage(u(100));
    expect(host.track).toHaveBeenCalledWith(
      'cache_break_detected',
      expect.objectContaining({
        prev_model: 'k2',
        curr_model: 'other-model',
        prev_input_cache_read: 10000,
        curr_input_cache_read: 100,
      }),
    );
  });
});

describe('CacheHintController scenario 1 (resume)', () => {
  /** maybeShowOnResume awaits the user's choice; dismiss the dialog once mounted. */
  async function showOnResumeAndDismiss(
    controller: CacheHintController,
    host: CacheHintHost,
  ): Promise<void> {
    const pending = controller.maybeShowOnResume();
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });
    const dialog = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      handleInput: (data: string) => void;
    };
    dialog.handleInput('\u001B');
    await pending;
  }

  it('shows the dialog on resume when idle beyond cache_duration', async () => {
    getMock.mockResolvedValue(CONFIG);
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await showOnResumeAndDismiss(controller, host);
    expect(host.track).toHaveBeenCalledWith(
      'cache_hint_shown',
      expect.objectContaining({ scene: 'resume' }),
    );
  });

  it('shows at most once per session', async () => {
    getMock.mockResolvedValue(CONFIG);
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await showOnResumeAndDismiss(controller, host);
    await controller.maybeShowOnResume();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });

  it('falls back to summary.updatedAt when there are no replay records', async () => {
    getMock.mockResolvedValue(CONFIG);
    const session = resumeSession([], 150000, Date.now() - 1200_000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await showOnResumeAndDismiss(controller, host);
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });

  it('drops the dialog when the session switched during the config fetch', async () => {
    let resolveFetch!: (config: CacheHintConfig) => void;
    getMock.mockImplementation(
      () =>
        new Promise<CacheHintConfig>((res) => {
          resolveFetch = res;
        }),
    );
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    const pending = controller.maybeShowOnResume();
    await flush(); // let the fetch start (resolveFetch gets assigned)
    (host as unknown as { session: unknown }).session = { id: 'other-session' };
    resolveFetch(CONFIG);
    await pending;
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('drops the dialog when a turn started during the config fetch', async () => {
    let resolveFetch!: (config: CacheHintConfig) => void;
    getMock.mockImplementation(
      () =>
        new Promise<CacheHintConfig>((res) => {
          resolveFetch = res;
        }),
    );
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host, state } = makeHost({ session });
    const controller = new CacheHintController(host);

    const pending = controller.maybeShowOnResume();
    await flush();
    // The user sent the first prompt while the fetch was in flight.
    state.appState.streamingPhase = 'waiting';
    resolveFetch(CONFIG);
    await pending;
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('re-evaluates against fresh activity when a turn completed during the config fetch', async () => {
    let resolveFetch!: (config: CacheHintConfig) => void;
    getMock.mockImplementation(
      () =>
        new Promise<CacheHintConfig>((res) => {
          resolveFetch = res;
        }),
    );
    // Idle long past the window when the resume check started…
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    const pending = controller.maybeShowOnResume();
    await flush(); // let the fetch start (resolveFetch gets assigned)
    // …but the user's first prompt ran to completion while the config was in
    // flight, refreshing the server-side cache — the stale replay timestamp
    // must not trigger the dialog.
    controller.recordActivity();
    resolveFetch(CONFIG);
    await pending;
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('ignores local-only state records when computing the resume idle time', async () => {
    getMock.mockResolvedValue(CONFIG);
    const oldMessage = { type: 'message', time: Date.now() - 1200_000 };
    const recentStateRecord = { type: 'permission_updated', time: Date.now() - 5000 };
    const session = {
      id: 's1',
      summary: { updatedAt: 0 },
      getResumeState: () => ({
        agents: {
          main: { replay: [oldMessage, recentStateRecord], context: { tokenCount: 150000 } },
        },
      }),
    };
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    // The recent permission change must not mask the expired cache.
    await showOnResumeAndDismiss(controller, host);
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });

  it('skips when the config cannot be resolved', async () => {
    const session = resumeSession([Date.now() - 1200_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await controller.maybeShowOnResume();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('skips small sessions below the token threshold', async () => {
    getMock.mockResolvedValue(CONFIG);
    const session = resumeSession([Date.now() - 1200_000], 50_000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await controller.maybeShowOnResume();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('seeds the activity baseline when the resume check skips inside the cache window', async () => {
    getMock.mockResolvedValue(CONFIG);
    peekMock.mockReturnValue(CONFIG);
    const now = Date.now();
    // 9 minutes into a 10-minute cache window — nothing to show on resume.
    const session = resumeSession([now - 540_000], 150000);
    const { host } = makeHost({ session });
    const controller = new CacheHintController(host);

    await controller.maybeShowOnResume();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();

    // Two minutes later the window has expired; the seeded baseline lets the
    // idle-submit path catch it instead of waving the prompt through.
    vi.spyOn(Date, 'now').mockReturnValue(now + 660_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(host.track).toHaveBeenCalledWith(
      'cache_hint_shown',
      expect.objectContaining({ scene: 'idle' }),
    );
    vi.restoreAllMocks();
  });
});
