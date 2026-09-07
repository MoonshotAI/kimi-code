import { describe, expect, it, vi } from 'vitest';

import {
  AuthFlowController,
  type AuthFlowHost,
} from '#/tui/controllers/auth-flow';

function makeHost(
  options: {
    withSession?: boolean;
    defaultModel?: string;
    boundModel?: string;
  } = {},
) {
  const appState = {
    workDir: '/tmp/work',
    additionalDirs: [] as string[],
    planMode: false,
    model: 'old-model',
    thinkingEffort: 'off',
  };
  const session =
    options.withSession === true
      ? {
          id: 'ses-live',
          getStatus: vi.fn(async () => ({ model: options.boundModel ?? 'old-model' })),
          setModel: vi.fn(async () => ({ model: 'k2', providerName: 'managed' })),
          setThinking: vi.fn(async () => {}),
        }
      : undefined;
  const host = {
    state: { appState },
    session,
    harness: {
      createSession: vi.fn(async () => ({ id: 'ses-new', summary: { title: null } })),
      getConfig: vi.fn(async () => ({
        defaultModel: options.defaultModel,
        models: { k2: { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 200_000 } },
        providers: {},
      })),
    },
    options: { startup: {} },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    setStartupReady: vi.fn(),
    resetSessionRuntime: vi.fn(),
    setSession: vi.fn(async (next: unknown) => {
      (host as { session: unknown }).session = next;
    }),
    syncRuntimeState: vi.fn(async () => {}),
    appendStartupNotice: vi.fn(),
    hydrateLazyConfigDefaults: vi.fn(async () => {}),
    sessionEventHandler: { startSubscription: vi.fn() },
    fetchSessions: vi.fn(async () => {}),
    updateTerminalTitle: vi.fn(),
    refreshSkillCommands: vi.fn(async () => {}),
    refreshPluginCommands: vi.fn(async () => {}),
  } as unknown as AuthFlowHost & {
    session: unknown;
    harness: {
      createSession: ReturnType<typeof vi.fn>;
      getConfig: ReturnType<typeof vi.fn>;
    };
    setAppState: ReturnType<typeof vi.fn>;
  };
  return { host, appState, session };
}

describe('activateModelAfterLogin', () => {
  it('reports an engine-tracked switch when the pick changes the bound alias', async () => {
    const { host, session } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(true);
    expect(session!.setModel).toHaveBeenCalledWith('k2');
    expect(session!.setThinking).toHaveBeenCalledWith('high');
  });

  it('reports no engine switch when the live session already binds the alias', async () => {
    const { host, session } = makeHost({ withSession: true, boundModel: 'k2' });
    const authFlow = new AuthFlowController(host);

    // setModel is an alias no-op here, so neither engine emits model_switch —
    // callers must stay the producer. The effort still goes through
    // setThinking, whose thinking_toggle is the engine's own event.
    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(false);
    expect(session!.setModel).toHaveBeenCalledWith('k2');
    expect(session!.setThinking).toHaveBeenCalledWith('high');
  });

  it('only patches app state and reports no engine switch on the session-less v2 path', async () => {
    const { host, appState } = makeHost();
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(engineTrackedSwitch).toBe(false);
    expect(host.harness.createSession).not.toHaveBeenCalled();
    expect(appState.model).toBe('k2');
    expect(appState).toMatchObject({ lazySessionThinking: 'high' });
  });
});

describe('refreshConfigAfterLogin', () => {
  it('reports false without activating when no default model is configured', async () => {
    const { host } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    const engineTrackedSwitch = await authFlow.refreshConfigAfterLogin();

    expect(engineTrackedSwitch).toBe(false);
  });

  it('propagates the activation result for the persisted default model', async () => {
    const live = makeHost({ withSession: true, defaultModel: 'k2' });
    const reachedLive = await new AuthFlowController(live.host).refreshConfigAfterLogin();
    expect(reachedLive).toBe(true);
    expect(live.session!.setModel).toHaveBeenCalledWith('k2');

    const lazy = makeHost({ defaultModel: 'k2' });
    const reachedLazy = await new AuthFlowController(lazy.host).refreshConfigAfterLogin();
    expect(reachedLazy).toBe(false);
    expect(lazy.host.harness.createSession).not.toHaveBeenCalled();
  });
});
