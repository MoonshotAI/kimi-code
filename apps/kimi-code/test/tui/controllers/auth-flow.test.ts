import { describe, expect, it, vi } from 'vitest';

import { AgentModelRef, ModelDefaultsRef } from '@moonshot-ai/agent-core';

import {
  AuthFlowController,
  type AuthFlowHost,
} from '#/tui/controllers/auth-flow';

function makeHost(
  options: {
    withSession?: boolean;
    defaultModel?: string;
    thinking?: { enabled?: boolean; effort?: string };
  } = {},
) {
  const appState = {
    workDir: '/tmp/work',
    planMode: false,
    model: 'old-model',
    thinkingEffort: 'off',
    availableModels: {} as AuthFlowHost['state']['appState']['availableModels'],
  };
  const setModel = vi.fn(async () => {});
  const setThinking = vi.fn(async () => {});
  const setDefaultModel = vi.fn(async () => {});
  const setDefaultThinking = vi.fn(async () => {});
  const main = options.withSession === true
    ? {
        resolve: (token: unknown) => {
          if (token === AgentModelRef) return { setModel, setThinking };
          throw new Error('unknown token');
        },
      }
    : undefined;
  const configGet = vi.fn((name: string): unknown => {
    if (name === 'defaultModel') return options.defaultModel;
    if (name === 'thinking') return options.thinking;
    return undefined;
  });
  const host = {
    state: { appState },
    session: options.withSession === true ? { id: 'ses-live' } : undefined,
    mainAgent: () => main,
    harness: {
      config: {
        get: configGet,
        reload: vi.fn(async () => {}),
      },
      app: {
        resolve: (token: unknown) => {
          if (token === ModelDefaultsRef) return { setDefaultModel, setDefaultThinking };
          throw new Error('unknown token');
        },
      },
    },
    options: { startup: {} },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    setStartupReady: vi.fn(),
    resetSessionRuntime: vi.fn(),
    appendStartupNotice: vi.fn(),
    hydrateLazyConfigDefaults: vi.fn(),
    refreshAvailableModels: vi.fn(),
  } as unknown as AuthFlowHost & {
    session: unknown;
    setAppState: ReturnType<typeof vi.fn>;
  };
  return { host, appState, setModel, setThinking, setDefaultModel, setDefaultThinking, configGet };
}

describe('activateModelAfterLogin', () => {
  it('applies the pick to the live agent and persists it as the default', async () => {
    const { host, setModel, setThinking, setDefaultModel, setDefaultThinking } = makeHost({
      withSession: true,
    });
    const authFlow = new AuthFlowController(host);

    const reachedLive = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(reachedLive).toBe(true);
    expect(setModel).toHaveBeenCalledWith('k2');
    expect(setThinking).toHaveBeenCalledWith('high');
    expect(setDefaultModel).toHaveBeenCalledWith('k2');
    expect(setDefaultThinking).toHaveBeenCalledWith('high');
  });

  it('persists defaults and patches app state on the session-less path', async () => {
    const { host, appState, setModel, setDefaultModel, setDefaultThinking } = makeHost();
    const authFlow = new AuthFlowController(host);

    const reachedLive = await authFlow.activateModelAfterLogin('k2', 'high');

    expect(reachedLive).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(setDefaultModel).toHaveBeenCalledWith('k2');
    expect(setDefaultThinking).toHaveBeenCalledWith('high');
    expect(appState.model).toBe('k2');
    expect(appState.thinkingEffort).toBe('high');
  });
});

describe('refreshConfigAfterLogin', () => {
  it('reports false without activating when no default model is configured', async () => {
    const { host, setModel } = makeHost({ withSession: true });
    const authFlow = new AuthFlowController(host);

    const reachedLive = await authFlow.refreshConfigAfterLogin();

    expect(reachedLive).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
  });

  it('reloads config and activates the persisted default model', async () => {
    const { host, setModel, setThinking } = makeHost({
      withSession: true,
      defaultModel: 'k2',
      thinking: { effort: 'high' },
    });
    host.state.appState.availableModels = {
      k2: { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 200_000 },
    };
    const authFlow = new AuthFlowController(host);

    const reachedLive = await authFlow.refreshConfigAfterLogin();

    expect(reachedLive).toBe(true);
    expect(host.harness.config.reload).toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith('k2');
    expect(setThinking).toHaveBeenCalledWith('high');
    expect(host.state.appState.model).toBe('k2');
    expect(host.state.appState.maxContextTokens).toBe(200_000);
  });
});
