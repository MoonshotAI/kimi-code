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
          replay: replayTimes.map((time) => ({ time })),
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

  it('swallows a cold-cache submit, fetches, and releases when no rule matches', async () => {
    const { host } = makeHost();
    const controller = new CacheHintController(host);
    controller.recordActivity();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    expect(controller.maybeInterceptOnSubmit('hello')).toBe(true);
    await flush();
    expect(getMock).toHaveBeenCalled();
    // Fetch resolved without a matching rule → the message is released.
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello');
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
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello');
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
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello');
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
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('hello');
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
});
