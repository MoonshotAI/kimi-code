import type { ManagedAccountProfileResult } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  AuthFlowController,
  type AuthFlowHost,
} from '#/tui/controllers/auth-flow';
import type { ManagedWorkspaceSummary } from '#/tui/types';
import {
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
} from '#/utils/model-switch-confirm-config';

function makeHost(
  options: {
    withSession?: boolean;
    defaultModel?: string;
    boundModel?: string;
  } = {},
) {
  const appState: {
    workDir: string;
    additionalDirs: string[];
    planMode: boolean;
    model: string;
    thinkingEffort: string;
    managedWorkspace?: ManagedWorkspaceSummary | null;
  } = {
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
      auth: { getCachedAccessToken: vi.fn(async () => 'test-token') },
    },
    options: { startup: {} },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    setStartupReady: vi.fn(),
    resetSessionRuntime: vi.fn(),
    setAuthRequired: vi.fn(),
    setSession: vi.fn(async (next: unknown) => {
      (host as { session: unknown }).session = next;
    }),
    syncRuntimeState: vi.fn(async () => {}),
    appendStartupNotice: vi.fn(),
    hydrateLazyConfigDefaults: vi.fn(async () => {}),
    waitForSessionAssembly: vi.fn(async () => {}),
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
      auth: Record<string, ReturnType<typeof vi.fn>>;
    };
    setAppState: ReturnType<typeof vi.fn>;
  };
  return { host, appState, session };
}

beforeEach(() => {
  resetModelSwitchConfirmConfigCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ name: 'model_switch_confirm', config: { enable: false, rules: [] } })),
    ),
  );
});

afterEach(() => {
  resetModelSwitchConfirmConfigCache();
  vi.unstubAllGlobals();
});

describe('login-required startup', () => {
  it('marks the application as blocked until authentication is resolved', () => {
    const { host } = makeHost();
    const authFlow = new AuthFlowController(host);

    authFlow.enterLoginRequiredStartupState();

    expect(host.setAuthRequired).toHaveBeenCalledWith(true);
  });
});

describe('activateModelAfterLogin', () => {
  it('clears auth required after a model is activated', async () => {
    const { host } = makeHost();
    const authFlow = new AuthFlowController(host);

    await authFlow.activateModelAfterLogin('k2', 'high');

    expect(host.setAuthRequired).toHaveBeenCalledWith(false);
  });

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

describe('refreshConfigAfterLogin with a matching cloud rule', () => {
  async function makeGateHost(
    options: { withSession?: boolean; sessionType?: 'old' | 'new' | 'all' } = {},
  ) {
    const withSession = options.withSession ?? true;
    const sessionType = options.sessionType ?? 'old';
    const { host, session, appState } = makeHost({ withSession, defaultModel: 'k2' });
    (appState as Record<string, unknown>)['streamingPhase'] = 'idle';
    host.harness.getConfig = vi.fn(async () => ({
      defaultModel: 'k2',
      models: {
        'old-model': { provider: 'managed:kimi-code', model: 'upstream-old', maxContextSize: 200_000 },
        k2: {
          provider: 'managed:kimi-code',
          model: 'upstream-new',
          maxContextSize: 200_000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
        },
      },
      providers: {},
    }));
    (host as unknown as { state: Record<string, unknown> }).state['transcriptEntries'] = withSession
      ? [{ kind: 'user', bullet: 'hi' }]
      : [];
    const mountEditorReplacement = vi.fn();
    (host as unknown as Record<string, unknown>)['mountEditorReplacement'] = mountEditorReplacement;
    (host as unknown as Record<string, unknown>)['restoreEditor'] = vi.fn();
    (host as unknown as Record<string, unknown>)['showStatus'] = vi.fn();
    (host as unknown as Record<string, unknown>)['showError'] = vi.fn();
    (host as unknown as Record<string, unknown>)['showNotice'] = vi.fn();
    (host as unknown as Record<string, unknown>)['track'] = vi.fn();
    (host as unknown as Record<string, unknown>)['authFlow'] = new AuthFlowController(host);
    await refreshModelSwitchConfirmConfig({
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ name: 'model_switch_confirm', config: { enable: false, rules: [] } })),
      ) as unknown as typeof fetch,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            name: 'model_switch_confirm',
            config: {
              enable: true,
              rules: [{ from: 'upstream-old', to: 'upstream-new', session_type: sessionType }],
            },
          }),
        ),
      ),
    );
    return { host, session, appState, mountEditorReplacement };
  }

  it('gates the activation through the confirmation dialog and skips setModel', async () => {
    const { host, session, mountEditorReplacement } = await makeGateHost();

    const result = await new AuthFlowController(host).refreshConfigAfterLogin();

    expect(result).toBe('gated');
    expect(session!.setModel).not.toHaveBeenCalled();
    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
  });

  it('gates an alias introduced by this login that the stale catalog lacks', async () => {
    const { host, session, appState, mountEditorReplacement } = await makeGateHost();
    (appState as Record<string, unknown>)['availableModels'] = {
      'old-model': { model: 'upstream-old', displayName: 'Old' },
    };

    const result = await new AuthFlowController(host).refreshConfigAfterLogin();

    expect(result).toBe('gated');
    expect(session!.setModel).not.toHaveBeenCalled();
    expect(mountEditorReplacement).toHaveBeenCalledTimes(1);
  });

  it('hydrates non-model defaults and uses the target effort after a session-less confirmation', async () => {
    const { host, appState, mountEditorReplacement } = await makeGateHost({
      withSession: false,
      sessionType: 'new',
    });

    const result = await new AuthFlowController(host).refreshConfigAfterLogin();

    expect(result).toBe('gated');
    expect(host.hydrateLazyConfigDefaults).toHaveBeenCalledWith(false);
    expect(appState.model).toBe('old-model');
    const dialog = mountEditorReplacement.mock.calls[0]?.[0] as unknown as {
      opts: { onSelect: (action: string) => void };
    };
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => {
      expect(appState).toMatchObject({ model: 'k2', thinkingEffort: 'high', lazySessionThinking: 'high' });
    });
  });

  it('forwards the caller picked effort to the gated dialog', async () => {
    const { host, session, mountEditorReplacement } = await makeGateHost();

    const result = await new AuthFlowController(host).refreshConfigAfterLogin('max');

    expect(result).toBe('gated');
    const dialog = mountEditorReplacement.mock.calls[0]?.[0] as unknown as {
      opts: { onSelect: (action: string) => void };
    };
    dialog.opts.onSelect('continue');
    await vi.waitFor(() => expect(session!.setThinking).toHaveBeenCalledWith('max'));
  });
});

describe('refreshProviderModels', () => {
  it('reloads app-state providers and models even when the engine reports no model change', async () => {
    const { host } = makeHost();
    const refreshProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: ['custom'],
      failed: [],
    }));
    (host.harness as unknown as { refreshProviderModels: unknown }).refreshProviderModels =
      refreshProviderModels;

    const result = await new AuthFlowController(host).refreshProviderModels({
      providerId: 'custom',
    });

    expect(refreshProviderModels).toHaveBeenCalledWith({ providerId: 'custom' });
    expect(result.unchanged).toEqual(['custom']);
    expect(host.setAppState).toHaveBeenCalledWith({
      availableModels: expect.anything(),
      availableProviders: expect.anything(),
    });
  });
});

describe('managed workspace state sync', () => {
  it('revokes auth and clears badge when getAccountProfile reports business membership removed', async () => {
    const { host, appState } = makeHost();
    appState.managedWorkspace = {
      hasBusinessWorkspace: true,
      planLabel: 'Premium',
    };
    host.harness.auth['status'] = vi.fn(async () => ({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    }));
    host.harness.auth['getAccountProfile'] = vi.fn(async () => ({
      kind: 'error' as const,
      status: 401,
      errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
      message: 'removed',
    }));

    await new AuthFlowController(host).refreshManagedWorkspaceInBackground();

    expect(appState.managedWorkspace).toBeNull();
    expect(host.setAuthRequired).toHaveBeenCalledWith(true);
  });

  it('discards an older background workspace refresh that finishes after logout', async () => {
    const { host, appState } = makeHost();
    let resolveProfile!: (value: ManagedAccountProfileResult) => void;
    host.harness.auth['status'] = vi.fn(async () => ({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    }));
    host.harness.auth['getAccountProfile'] = vi.fn(
      () =>
        new Promise<ManagedAccountProfileResult>((resolve) => {
          resolveProfile = resolve;
        }),
    );

    const authFlow = new AuthFlowController(host);
    const pendingRefresh = authFlow.refreshManagedWorkspaceInBackground();
    await vi.waitFor(() => expect(host.harness.auth['getAccountProfile']).toHaveBeenCalledTimes(1));

    await authFlow.refreshConfigAfterLogout();
    expect(appState.managedWorkspace).toBeNull();

    resolveProfile({
      kind: 'ok',
      profile: {
        userId: 'u1',
        nickname: 'Alice',
        userLevelName: 'Premium',
        workspaces: [],
        hasBusinessWorkspace: true,
        activeWorkspaceName: 'Acme Corp',
        statusWorkspaceLine: 'Alice · Acme Corp',
        planLabel: 'Premium',
      },
    });
    await pendingRefresh;

    expect(appState.managedWorkspace).toBeNull();
  });

  it('applies switched workspace profile without firing a redundant background profile fetch', async () => {
    const { host, appState } = makeHost({ defaultModel: 'k2' });
    const getAccountProfile = vi.fn();
    host.harness.auth['getAccountProfile'] = getAccountProfile;
    host.harness.auth['switchWorkspace'] = vi.fn(async () => ({
      providerName: 'managed:kimi-code',
      ok: true as const,
      target: { kind: 'business' as const, businessId: 'biz-1' },
      profile: {
        userId: 'u1',
        nickname: 'Alice',
        userLevelName: 'Premium',
        workspaceName: 'Acme Corp',
        workspaces: [],
        hasBusinessWorkspace: true,
        activeWorkspaceName: 'Acme Corp',
        statusWorkspaceLine: 'Alice · Acme Corp',
        planLabel: 'Premium',
      },
    }));

    const summary = await new AuthFlowController(host).switchWorkspace(
      { kind: 'business', businessId: 'biz-1' },
      {
        kind: 'business',
        key: 'business:biz-1',
        target: { kind: 'business', businessId: 'biz-1' },
        businessId: 'biz-1',
        name: 'Acme Corp',
        status: 'STATUS_ACTIVE',
        kindLabel: 'Business workspace',
        current: false,
        disabled: false,
        switchable: true,
        roles: ['member'],
      },
    );

    expect(summary).toEqual({ displayName: 'Acme Corp' });
    expect(appState.managedWorkspace).toEqual({
      hasBusinessWorkspace: true,
      statusWorkspaceLine: 'Alice · Acme Corp',
      planLabel: 'Premium',
    });
    expect(getAccountProfile).not.toHaveBeenCalled();
  });

  it('clears stale workspace badge when switchWorkspace commits without profile and background fetch fails', async () => {
    const { host, appState } = makeHost({ defaultModel: 'k2' });
    appState.managedWorkspace = {
      hasBusinessWorkspace: true,
      statusWorkspaceLine: 'Alice · Old Corp',
      planLabel: 'Premium',
    };
    host.harness.auth['status'] = vi.fn(async () => ({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    }));
    host.harness.auth['getAccountProfile'] = vi.fn(async () => ({
      kind: 'error' as const,
      status: 502,
      message: 'Failed to fetch profile: HTTP 502',
    }));
    host.harness.auth['switchWorkspace'] = vi.fn(async () => ({
      providerName: 'managed:kimi-code',
      ok: true as const,
      target: { kind: 'personal' as const },
      warning: 'Failed to fetch profile: HTTP 502',
    }));

    const summary = await new AuthFlowController(host).switchWorkspace(
      { kind: 'personal' },
      {
        kind: 'personal',
        key: 'personal',
        target: { kind: 'personal' },
        name: 'Alice',
        kindLabel: 'Personal workspace',
        current: false,
        disabled: false,
        switchable: true,
        roles: ['owner'],
      },
    );

    expect(summary).toEqual({
      displayName: 'Alice · Personal workspace',
      warning: 'Failed to fetch profile: HTTP 502',
    });
    expect(appState.managedWorkspace).toBeNull();
  });

  it('activates the new default model during a streaming workspace switch when the current alias was removed', async () => {
    const { host, session, appState } = makeHost({ withSession: true, defaultModel: 'k2-next' });
    (appState as Record<string, unknown>)['streamingPhase'] = 'streaming';
    appState.model = 'enterprise-only-model';
    host.harness.getConfig = vi.fn(async () => ({
      defaultModel: 'k2-next',
      models: {
        'k2-next': {
          provider: 'managed:kimi-code',
          model: 'kimi-for-coding',
          maxContextSize: 256_000,
        },
      },
      providers: {},
    }));
    host.harness.auth['switchWorkspace'] = vi.fn(async () => ({
      providerName: 'managed:kimi-code',
      ok: true as const,
      target: { kind: 'personal' as const },
    }));

    await new AuthFlowController(host).switchWorkspace(
      { kind: 'personal' },
      {
        kind: 'personal',
        key: 'personal',
        target: { kind: 'personal' },
        name: 'Alice',
        kindLabel: 'Personal workspace',
        current: false,
        disabled: false,
        switchable: true,
        roles: ['owner'],
      },
    );

    expect(session!.setModel).toHaveBeenCalledWith('k2-next');
    expect(appState.model).toBe('k2-next');
  });

  it('falls back to config.defaultModel on both streaming and idle workspace switches when startup --model was removed', async () => {
    for (const streamingPhase of ['streaming', 'idle'] as const) {
      const { host, session, appState } = makeHost({ withSession: true, defaultModel: 'k2-next' });
      (host.options.startup as { model?: string }).model = 'enterprise-only-model';
      (appState as Record<string, unknown>)['streamingPhase'] = streamingPhase;
      appState.model = 'enterprise-only-model';
      host.harness.getConfig = vi.fn(async () => ({
        defaultModel: 'k2-next',
        models: {
          'k2-next': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 256_000,
          },
        },
        providers: {},
      }));
      host.harness.auth['switchWorkspace'] = vi.fn(async () => ({
        providerName: 'managed:kimi-code',
        ok: true as const,
        target: { kind: 'personal' as const },
      }));

      await new AuthFlowController(host).switchWorkspace(
        { kind: 'personal' },
        {
          kind: 'personal',
          key: 'personal',
          target: { kind: 'personal' },
          name: 'Alice',
          kindLabel: 'Personal workspace',
          current: false,
          disabled: false,
          switchable: true,
          roles: ['owner'],
        },
      );

      expect(session!.setModel).toHaveBeenCalledWith('k2-next');
      expect(appState.model).toBe('k2-next');
    }
  });

  it('clears stale workspace without setting authRequired when active model uses a custom provider', async () => {
    const { host, appState } = makeHost({ defaultModel: 'custom-gpt' });
    appState.model = 'custom-gpt';
    (appState as Record<string, unknown>)['availableModels'] = {
      'custom-gpt': {
        provider: 'custom-openai',
        model: 'gpt-4o',
        maxContextSize: 128_000,
      },
    };
    appState.managedWorkspace = {
      hasBusinessWorkspace: true,
      statusWorkspaceLine: 'Alice · Old Corp',
    };
    host.harness.auth['status'] = vi.fn(async () => ({
      providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
    }));
    host.harness.auth['getAccountProfile'] = vi.fn(async () => ({
      kind: 'error' as const,
      status: 401,
      errorCode: 'REASON_BUSINESS_MEMBER_REMOVED',
      message: 'Removed',
    }));

    await new AuthFlowController(host).refreshManagedWorkspaceInBackground();

    expect(appState.managedWorkspace).toBeNull();
    expect(host.setAuthRequired).not.toHaveBeenCalled();
  });

  it('ignores stale applyAccountProfile calls when generation has advanced', () => {
    const { host, appState } = makeHost();
    const authFlow = new AuthFlowController(host);
    const beforeLogoutGen = authFlow.captureWorkspaceGeneration();
    authFlow.clearManagedWorkspace();

    authFlow.applyAccountProfile(
      {
        userId: 'u1',
        nickname: 'Alice',
        userLevelName: 'Premium',
        workspaces: [],
        hasBusinessWorkspace: true,
        activeWorkspaceName: 'Acme Corp',
        statusWorkspaceLine: 'Alice · Acme Corp',
        planLabel: 'Premium',
      },
      beforeLogoutGen,
    );

    expect(appState.managedWorkspace).toBeNull();
  });
});
