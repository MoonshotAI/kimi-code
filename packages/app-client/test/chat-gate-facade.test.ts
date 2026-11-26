import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { browserReferenceNode, composerSchema, createComposerSnapshot, docToText } from '@moonshot-ai/app-composer/model';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';

const clientApiMock: Record<string, unknown> = {};

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  clientApiMock.getWorkspaceTrust = vi.fn(async () => ({ trusted: true }));
});

afterEach(() => {
  resetKimiClientDeps();
});

type Facade = Awaited<ReturnType<typeof freshFacade>>;

let eventHandlers: KimiEventHandlers | undefined;

function stubEventConnection(): void {
  eventHandlers = undefined;
  clientApiMock.connectEvents = vi.fn((handlers: KimiEventHandlers) => {
    eventHandlers = handlers;
    return {
      subscribeConversation: vi.fn(),
      unsubscribeConversation: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
  });
}

function emitMainAgentState(sessionId: string, model?: string): void {
  eventHandlers?.onAgentState?.(sessionId, 'main', {
    status: 'idle',
    model,
    planMode: false,
    swarmMode: false,
    towerMode: false,
  });
}

async function freshFacade() {
  vi.stubGlobal('WebSocket', class {});
  vi.resetModules();
  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { authStore } = await import('../src/stores/auth');
  const { modelsStore } = await import('../src/stores/models');
  const { sessionsStore } = await import('../src/stores/sessions');
  const { DaemonApiError, DaemonNetworkError } = await import('@moonshot-ai/app-core/api');
  return {
    client: useKimiWebClient(),
    auth: authStore(),
    models: modelsStore(),
    sessions: sessionsStore(),
    DaemonApiError,
    DaemonNetworkError,
  };
}

const MODEL = { id: 'openai/gpt-4o', model: 'gpt-4o', provider: 'openai' } as never;
const MANAGED_MODEL = { id: 'managed:kimi-code/kimi-k2', model: 'kimi-k2', provider: 'managed:kimi-code' } as never;

function session(id: string, model = ''): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    workspaceId: 'workspace-1',
  };
}

function authError(f: Facade, code: number, details?: unknown): DaemonApiError {
  return new f.DaemonApiError({ code, msg: `auth error ${code}`, requestId: 'req_1', details });
}

describe('ensureChatReady — the §2.3 decision flow', () => {
  it('passes without any probe when the resolution chain already yields a valid model', async () => {
    const { client, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    models.setModels([MODEL]);
    models.setDefaultModel('openai/gpt-4o');

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('passes when the active session model resolves', async () => {
    const { client, models, sessions } = await freshFacade();
    stubEventConnection();
    models.setModels([MODEL]);
    sessions.setSessions([session('s1', 'openai/gpt-4o')]);
    sessions.setActiveSessionId('s1');

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it('re-probes and passes when the server snapshot reports modelsReady (cold cache window)', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => []);

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getAuth).toHaveBeenCalledTimes(1);
  });

  it('re-probes even when a stale modelsReady:true is cached (the fast path requires a valid local resolution chain)', async () => {
    const { client, models } = await freshFacade();
    models.setModelsReady(true);
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getAuth).toHaveBeenCalledTimes(1);
    expect(clientApiMock.getConfig).toHaveBeenCalled();
    expect(models.defaultModel).toBe('openai/gpt-4o');
  });

  it('passes on a transient probe failure (retry) instead of mapping stale caches to login/configure', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => {
      throw new Error('connection refused');
    });
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it('passes when /auth proceeds but the models probe fails transiently', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: false, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => {
      throw new Error('network down');
    });
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it('passes when /auth proceeds but the config probe fails transiently', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: false, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it("returns 'server-auth-required' when the daemon wants a server credential (ServerAuthDialog owns recovery)", async () => {
    const { client, DaemonApiError } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => {
      throw new DaemonApiError({ code: 401, msg: 'Unauthorized', requestId: 'req_1' });
    });
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));

    await expect(client.ensureChatReady()).resolves.toBe('server-auth-required');
  });

  it('pick-model when models exist but no default resolves', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: false, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));

    await expect(client.ensureChatReady()).resolves.toBe('pick-model');
  });

  it('refreshes the /config channel on re-probe so a pass also converges the prompt model parameter', async () => {
    const { client, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    expect(models.defaultModel).toBeNull();

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getConfig).toHaveBeenCalled();
    expect(models.defaultModel).toBe('openai/gpt-4o');
  });

  it('login when signed out with no models', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: false, providersCount: 0, managedProvider: null }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));

    await expect(client.ensureChatReady()).resolves.toBe('login');
  });

  it('upgrade when signed in and the awaited membership probe confirms free', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));
    clientApiMock.getUserInfo = vi.fn(async () => ({ kind: 'error', message: 'payment required', status: 402 }));

    await expect(client.ensureChatReady()).resolves.toBe('upgrade');
  });

  it('upgrade when a free account resolves a managed subscription model on the fast path', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');
    clientApiMock.getUserInfo = vi.fn(async () => ({ kind: 'error', message: 'payment required', status: 402 }));

    await expect(client.ensureChatReady()).resolves.toBe('upgrade');
    expect(clientApiMock.getUserInfo).toHaveBeenCalledTimes(1);
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('ok on the fast path when the probe supersedes a cached free membership', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'free';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 30, userLevelName: 'Vivace', domain: 1, domainName: 'd' },
    }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('passes without any probe on the fast path once membership is known to be paid', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    clientApiMock.getUserInfo = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'member';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getUserInfo).not.toHaveBeenCalled();
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('ok when a free account resolves a non-managed model (no membership probe needed)', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    clientApiMock.getUserInfo = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'free';
    models.setModels([MODEL]);
    models.setDefaultModel('openai/gpt-4o');

    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getUserInfo).not.toHaveBeenCalled();
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('upgrade on the fast path when a v2-plan account at level 15 resolves a managed model', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 15, userLevelName: 'Andante', domain: 1, domainName: 'd', goodsVersion: 2 },
    }));

    await expect(client.ensureChatReady()).resolves.toBe('upgrade');
  });

  it('ok on the fast path when a v2-plan account at level 16 resolves a managed model', async () => {
    const { client, auth, models } = await freshFacade();
    clientApiMock.getAuth = vi.fn();
    auth.managedProviderStatus = 'authenticated';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 16, userLevelName: 'Allegro', domain: 1, domainName: 'd', goodsVersion: 2 },
    }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it('configure-model when the fresh membership probe supersedes a cached free membership', async () => {
    const { client, auth } = await freshFacade();
    auth.managedMembership = 'free';
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));
    let resolveUserInfo!: (value: unknown) => void;
    clientApiMock.getUserInfo = vi.fn(
      () => new Promise((resolve) => { resolveUserInfo = resolve; }),
    );
    clientApiMock.refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [],
      unchanged: [],
      failed: [{ provider: 'managed:kimi-code', reason: 'token expired' }],
    }));

    const ready = client.ensureChatReady();
    await vi.waitFor(() => expect(clientApiMock.getUserInfo).toHaveBeenCalled());
    resolveUserInfo({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 30, userLevelName: 'Vivace', domain: 1, domainName: 'd' },
    });

    await expect(ready).resolves.toBe('configure-model');
  });

  it('configure-model when signed in with no models and the OAuth refresh fails', async () => {
    const { client } = await freshFacade();
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 30, userLevelName: 'Vivace', domain: 1, domainName: 'd' },
    }));
    clientApiMock.refreshOAuthProviderModels = vi.fn(async () => ({ changed: [], unchanged: [], failed: [{ provider: 'managed:kimi-code', reason: 'token expired' }] }));

    await expect(client.ensureChatReady()).resolves.toBe('configure-model');
    expect(clientApiMock.refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
  });

  it('configure-model when the OAuth refresh throws', async () => {
    const { client, auth } = await freshFacade();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'member';
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {} }));
    clientApiMock.refreshOAuthProviderModels = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(client.ensureChatReady()).resolves.toBe('configure-model');
  });

  it('blocks ensureChatReady while a workspace switch is in flight and evaluates the switched workspace state', async () => {
    const { client, auth, models } = await freshFacade();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'member';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');

    let resolveSwitch!: (value: unknown) => void;
    clientApiMock.switchManagedWorkspace = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: true,
      providersCount: 1,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'error',
      status: 402,
      message: 'payment required',
    }));
    clientApiMock.listManagedWorkspaces = vi.fn(async () => ({
      kind: 'ok',
      workspaces: [],
    }));
    clientApiMock.listModels = vi.fn(async () => [MANAGED_MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({
      providers: {},
      defaultModel: 'managed:kimi-code/kimi-k2',
    }));

    const switching = auth.switchManagedWorkspace({ kind: 'personal' }, 'Personal');
    let gateResolved = false;
    const ready = client.ensureChatReady().then((verdict) => {
      gateResolved = true;
      return verdict;
    });

    await Promise.resolve();
    expect(gateResolved).toBe(false);

    resolveSwitch({
      kind: 'ok',
      provider: 'managed:kimi-code',
      target: { kind: 'personal' },
    });

    await switching;
    await expect(ready).resolves.toBe('upgrade');
  });

  it('configure-model when the OAuth refresh lands but the auth convergence probe retries (ok:false, no stale-cache recovery)', async () => {
    const { client, auth } = await freshFacade();
    auth.managedProviderStatus = 'authenticated';
    auth.managedMembership = 'member';
    let authCall = 0;
    clientApiMock.getAuth = vi.fn(async () => {
      authCall += 1;
      if (authCall >= 2) throw new Error('connection refused');
      return { modelsReady: false, providersCount: 0, managedProvider: { status: 'authenticated' } };
    });
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 30, userLevelName: 'Vivace', domain: 1, domainName: 'd' },
    }));
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [{ providerId: 'managed:kimi-code', providerName: 'Kimi', added: 1, removed: 0 }],
      unchanged: [],
      failed: [],
    }));

    await expect(client.ensureChatReady()).resolves.toBe('configure-model');
    expect(clientApiMock.refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
  });

  it('ok after the OAuth refresh self-heals the catalog (loadModels → loadConfig → checkAuth converge)', async () => {
    const { client } = await freshFacade();
    let modelsCall = 0;
    let authCall = 0;
    clientApiMock.getAuth = vi.fn(async () => {
      authCall += 1;
      return {
        modelsReady: authCall >= 2,
        providersCount: 1,
        managedProvider: { status: 'authenticated' },
      };
    });
    clientApiMock.listModels = vi.fn(async () => {
      modelsCall += 1;
      return modelsCall >= 2 ? [MODEL] : [];
    });
    clientApiMock.getUserInfo = vi.fn(async () => ({
      kind: 'ok',
      userInfo: { userId: 'u', nickname: 'n', status: 'active', region: 'global', userLevel: 30, userLevelName: 'Vivace', domain: 1, domainName: 'd' },
    }));
    clientApiMock.refreshOAuthProviderModels = vi.fn(async () => ({
      changed: [{ providerId: 'managed:kimi-code', providerName: 'Kimi', added: 1, removed: 0 }],
      unchanged: [],
      failed: [],
    }));
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));

    await expect(client.ensureChatReady()).resolves.toBe('ok');
  });

  it('single-flight: concurrent ensureChatReady calls share one decision flow', async () => {
    const { client } = await freshFacade();
    let resolveAuth!: (value: unknown) => void;
    clientApiMock.getAuth = vi.fn(
      () =>
        new Promise((done) => {
          resolveAuth = done;
        }),
    );
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));

    const first = client.ensureChatReady();
    const second = client.ensureChatReady();
    resolveAuth({ modelsReady: false, providersCount: 1, managedProvider: null });

    await expect(first).resolves.toBe('pick-model');
    await expect(second).resolves.toBe('pick-model');
    expect(clientApiMock.getAuth).toHaveBeenCalledTimes(1);
    expect(clientApiMock.listModels).toHaveBeenCalledTimes(1);
  });
});

describe('remote chat isolation', () => {
  async function remoteFacade() {
    const facade = await freshFacade();
    stubEventConnection();
    const { workspacesStore } = await import('../src/stores/workspaces');
    const { nextTick } = await import('vue');
    const workspaces = workspacesStore();
    workspaces.workspaces = [{
      id: 'workspace-1', root: '/srv/project', name: 'Remote', hostId: 'devbox',
      kind: 'managed', additionalDirs: [], sessionCount: 0,
    }];
    workspaces.storedActiveWorkspaceId = 'workspace-1';
    await nextTick();
    clientApiMock.deviceApi = vi.fn(() => ({
      listModels: vi.fn(async () => [MANAGED_MODEL]),
      getConfig: vi.fn(async () => ({ defaultModel: 'managed:kimi-code/kimi-k2' })),
    }));
    await facade.models.loadHostCatalog('devbox');
    clientApiMock.getAuth = vi.fn();
    clientApiMock.getUserInfo = vi.fn();
    facade.auth.managedProviderStatus = 'authenticated';
    facade.auth.managedMembership = 'free';
    return { ...facade, workspaces, nextTick };
  }

  it('lets the remote server authorize drafts and sessions without probing the local free account', async () => {
    const { client, sessions } = await remoteFacade();
    expect(client.chatGateVerdict.value).toBe('ok');
    await expect(client.ensureChatReady()).resolves.toBe('ok');
    sessions.setSessions([{ ...session('remote', 'managed:kimi-code/kimi-k2'), hostId: 'devbox' }]);
    sessions.setActiveSessionId('remote');
    await expect(client.ensureChatReady()).resolves.toBe('ok');
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
    expect(clientApiMock.getUserInfo).not.toHaveBeenCalled();
  });

  it('reports remote auth failures without redirecting to the local account', async () => {
    const f = await remoteFacade();
    f.sessions.setSessions([{ ...session('remote', 'managed:kimi-code/kimi-k2'), hostId: 'devbox' }]);
    f.sessions.setActiveSessionId('remote');
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40111, { provider_id: 'managed:kimi-code' });
    });
    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.sendFailureVerdict.value).toBeNull();
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('keeps the local default when selecting a remote model and still saves local selections', async () => {
    const { client, models, workspaces, nextTick } = await remoteFacade();
    models.setModels([MODEL]);
    models.setDefaultModel('openai/gpt-4o');
    clientApiMock.setConfig = vi.fn(async (patch) => patch);
    await client.selectModel('managed:kimi-code/kimi-k2');
    expect(clientApiMock.setConfig).not.toHaveBeenCalled();
    expect(models.defaultModel).toBe('openai/gpt-4o');
    workspaces.workspaces = [];
    workspaces.storedActiveWorkspaceId = null;
    models.setDefaultModel(null);
    await nextTick();
    await client.selectModel('openai/gpt-4o');
    expect(clientApiMock.setConfig).toHaveBeenCalledWith({ defaultModel: 'openai/gpt-4o' });
  });
});

describe('load — global event socket', () => {
  function mockLoadEndpoints(): void {
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));
    clientApiMock.getHealth = vi.fn(async () => ({ status: 'ok', uptimeSec: 1 }));
    clientApiMock.getMeta = vi.fn(async () => ({
      serverVersion: '0.0.0',
      serverId: 'server-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      capabilities: {},
      openInApps: [],
      dangerousBypassAuth: false,
      backend: 'v2',
    }));
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.listProviders = vi.fn(async () => []);
    clientApiMock.listWorkspaces = vi.fn(async () => [
      { id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: 0 },
    ]);
    clientApiMock.getFsHome = vi.fn(async () => ({ home: '/home/test', recentRoots: [] }));
    clientApiMock.listSessions = vi.fn(async () => ({ items: [], hasMore: false, nextPageToken: null, total: 0 }));
    clientApiMock.listSessionGroups = vi.fn(async () => ({
      groups: [{ workspaceId: 'workspace-1', sessions: [], total: 0 }],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    }));
  }

  it('opens the event socket during load so global events reach the draft home (and stays idempotent on reload)', async () => {
    const f = await freshFacade();
    stubEventConnection();
    mockLoadEndpoints();

    await f.client.load();
    expect(clientApiMock.connectEvents).toHaveBeenCalledTimes(1);

    await f.client.load();
    expect(clientApiMock.connectEvents).toHaveBeenCalledTimes(1);
  });
});

describe('chatGateVerdict — the sync facade computed', () => {
  it('recomputes on defaultModel / models / draftModel changes', async () => {
    const { client, models } = await freshFacade();

    expect(client.chatGateVerdict.value).toBe('login');

    models.setDefaultModel('openai/gpt-4o');
    expect(client.chatGateVerdict.value).toBe('login');

    models.setModels([MODEL]);
    expect(client.chatGateVerdict.value).toBe('ok');

    models.setDefaultModel('deleted/model');
    expect(client.chatGateVerdict.value).toBe('pick-model');

    models.setDraftModel('openai/gpt-4o');
    expect(client.chatGateVerdict.value).toBe('ok');
  });

  it('flips between upgrade and ok on a managed model as membership resolves', async () => {
    const { client, auth, models } = await freshFacade();

    auth.managedProviderStatus = 'authenticated';
    models.setModels([MANAGED_MODEL]);
    models.setDefaultModel('managed:kimi-code/kimi-k2');
    expect(client.chatGateVerdict.value).toBe('ok');

    auth.managedMembership = 'free';
    expect(client.chatGateVerdict.value).toBe('upgrade');

    auth.managedMembership = 'member';
    expect(client.chatGateVerdict.value).toBe('ok');
  });

  it('recomputes on modelsReady / sign-in / membership / active-session changes', async () => {
    const { client, auth, models, sessions } = await freshFacade();

    expect(client.chatGateVerdict.value).toBe('login');

    models.setModelsReady(true);
    expect(client.chatGateVerdict.value).toBe('ok');
    models.setModelsReady(false);

    auth.managedProviderStatus = 'authenticated';
    expect(client.chatGateVerdict.value).toBe('configure-model');
    auth.managedMembership = 'free';
    expect(client.chatGateVerdict.value).toBe('upgrade');

    models.setModels([MODEL]);
    auth.managedMembership = 'member';
    stubEventConnection();
    sessions.setSessions([session('s1', 'openai/gpt-4o'), session('s2', 'deleted/model')]);
    sessions.setActiveSessionId('s1');
    expect(client.chatGateVerdict.value).toBe('ok');
    sessions.setActiveSessionId('s2');
    expect(client.chatGateVerdict.value).toBe('pick-model');
  });
});

describe('send-failure → verdict channel (§2.2)', () => {
  async function seedIdleSession(f: Facade, model = 'openai/gpt-4o'): Promise<void> {
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', model)]);
    f.sessions.setActiveSessionId('s1');
  }

  function expectSendFailureNotice(f: Facade): void {
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.sendFailedTitle',
      message: 'warnings.sendFailedNoDefaultModelMessage',
    });
  }

  function mockPassingGateRecheck(): void {
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: true,
      providersCount: 1,
      managedProvider: null,
    }));
  }

  it('prompt 40111 on the managed provider surfaces login and still toasts the send failure', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40111, { provider_id: 'managed:kimi-code' });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'login', sessionId: 's1' });
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonApiTitle',
    });
    f.client.dismissSendFailureVerdict();
    expect(f.client.sendFailureVerdict.value).toBeNull();
  });

  it('submits an immutable composer snapshot as client metadata separately from model text', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    const snapshot = {
      version: 1 as const,
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '[literal](example.md)' }] }] },
      attachments: [],
      attachmentOrder: [],
    };
    const expected = structuredClone(snapshot);
    const submit = vi.fn(async () => ({ promptId: 'prompt-snapshot', userMessageId: 'prompt-snapshot', status: 'running' as const }));
    clientApiMock.submitPrompt = submit;
    const envelope = f.client.createPromptEnvelope({ text: 'model text', snapshot });
    snapshot.doc.content[0]!.content[0]!.text = 'later edit';
    await expect(f.client.sendPrompt(envelope)).resolves.toBe('ok');
    expect(submit).toHaveBeenCalledWith('s1', expect.objectContaining({
      metadata: { kimi_code_composer: expected, display_text: '[literal](example.md)' },
      content: [{ type: 'text', text: 'model text' }],
    }));
  });

  it('prompt 40113 toasts the default-model guidance even when the gate re-check passes', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    mockPassingGateRecheck();
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113);
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    expectSendFailureNotice(f);
    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'ok', sessionId: 's1' });
    });
  });

  it('prompt 40113 with a dangling model alias keeps the generic notice', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    mockPassingGateRecheck();
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonApiTitle',
      message: 'auth error 40113',
    });
    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'ok', sessionId: 's1' });
    });
  });

  it('prompt failure from a network error keeps the network copy and produces no verdict', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw new f.DaemonNetworkError({
        message: 'fetch failed',
        cause: new Error('connection reset'),
        method: 'POST',
        path: '/sessions/s1/prompts',
        url: 'http://daemon/sessions/s1/prompts',
        requestId: 'req_1',
        phase: 'fetch',
        timeoutMs: 30000,
      });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    expect(f.client.sendFailureVerdict.value).toBeNull();
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonNetworkTitle',
      message: 'warnings.daemonNetworkMessage',
    });
  });

  it('steers browser reference evidence and client metadata only when the composer snapshot is carried', async () => {
    const capture: BrowserCapture = {
      version: 1, id: 'capture', ordinal: 1, label: 'Button: Save', capturedAt: '2026-09-07T00:00:00.000Z',
      page: { url: 'https://example.test', title: 'Example' },
      target: { kind: 'element', tagName: 'button', text: 'Save', bounds: { x: 1, y: 1, width: 2, height: 2 } },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 2 },
      screenshot: { attachmentId: 'shot', crop: { x: 1, y: 1, width: 2, height: 2 }, pixelWidth: 10, pixelHeight: 6 },
    };
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [browserReferenceNode({ refId: 'ref-a', label: capture.label })])]);
    const snapshot = createComposerSnapshot(doc, [{ attId: 'shot', key: 'blob:shot', kind: 'image', name: 'shot.png', purpose: 'browser-screenshot', fileId: 'file-shot', uploading: false, refCount: 0 }], ['shot'], {
      references: [{ id: 'ref-a', captureId: capture.id, comment: 'Rename this' }],
      captures: [capture],
    });
    const text = docToText(doc);
    const attachments = [{ clientId: 'shot', kind: 'image' as const, fileId: 'file-shot', name: 'shot.png' }];

    const f = await freshFacade();
    await seedIdleSession(f);
    mockPassingGateRecheck();
    const bodies: { promptId?: string; content: { type: string; text?: string }[]; metadata?: Record<string, unknown> }[] = [];
    let resolveFirst!: () => void;
    clientApiMock.submitPrompt = vi.fn(async (_sid: string, body: (typeof bodies)[number]) => {
      bodies.push(body);
      const echo = { promptId: body.promptId!, userMessageId: body.promptId! };
      if (bodies.length === 1) return new Promise((resolve) => { resolveFirst = () => resolve(echo); });
      return { ...echo, status: 'queued' };
    });
    clientApiMock.steerPrompt = clientApiMock.submitPrompt;
    clientApiMock.steerPrompts = vi.fn(async (_sid: string, promptIds: string[]) => ({ steered: true, promptIds }));

    const first = f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'first' }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    resolveFirst();
    await first;
    await vi.waitFor(() => expect(f.client.activity.value).toBe('running'));

    await f.client.steerPromptDirect(f.client.createPromptEnvelope({ text, attachments, snapshot }));
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(clientApiMock.steerPrompts).not.toHaveBeenCalled();
    const carried = bodies[1]!;
    expect(carried.content.map((part) => part.text ?? '').join('\n')).toContain('<browser_references version="1">');
    expect(carried.content.some((part) => part.type === 'image')).toBe(true);
    expect(carried.metadata).toMatchObject({ kimi_code_composer: { browserReferences: [{ id: 'ref-a' }] } });

    await f.client.steerPromptDirect(f.client.createPromptEnvelope({ text, attachments }));
    await vi.waitFor(() => expect(bodies).toHaveLength(3));
    const dropped = bodies[2]!;
    expect(dropped.content.map((part) => part.text ?? '').join('\n')).not.toContain('<browser_references');
    expect(dropped.metadata?.['kimi_code_composer']).toBeUndefined();
  });

  it('steer 40113 toasts the same failure copy and maps the verdict like a plain send', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    let resolveSubmit!: () => void;
    let submitCall = 0;
    clientApiMock.submitPrompt = vi.fn(async (_sid: string, input: { promptId?: string }) => {
      submitCall += 1;
      if (submitCall === 1) {
        return new Promise((resolve) => {
          resolveSubmit = () => resolve({ promptId: input.promptId!, userMessageId: input.promptId! });
        });
      }
      throw authError(f, 40113);
    });

    const first = f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'first' }));
    await vi.waitFor(() => expect(f.client.activity.value).toBe('running'));

    await expect(f.client.steerPrompt(f.client.createPromptEnvelope({ text: 'steer note' }))).resolves.toBe('rejected');

    expectSendFailureNotice(f);
    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'configure-model', sessionId: 's1' });
    });

    resolveSubmit();
    await expect(first).resolves.toBe('ok');
  });

  it('prompt 40113 force-refreshes the catalog and lands on configure-model when it comes back empty', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    f.models.setModelsReady(true);
    f.auth.managedProviderStatus = 'authenticated';
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 0,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113);
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'configure-model', sessionId: 's1' });
    });
    expect(clientApiMock.listModels).toHaveBeenCalled();
    expectSendFailureNotice(f);
  });

  it('prompt 40113 keeps the initial verdict when the catalog refresh itself fails', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.listModels = vi.fn(async () => {
      throw new Error('network down');
    });
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113);
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'pick-model', sessionId: 's1' });
    });
    expect(
      f.client.warnings.value.some(
        (w) => w.title === 'warnings.sendFailedTitle' && w.message === 'warnings.sendFailedNoDefaultModelMessage',
      ),
    ).toBe(true);
  });

  it('prompt 40113 keeps the initial verdict when the auth refresh answers retry', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.getAuth = vi.fn(async () => {
      throw new Error('connection refused');
    });
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'pick-model', sessionId: 's1' });
    });
  });

  it('prompt 40113 routes to configure-model when the emptied catalog lands even if another channel fails', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.listModels = vi.fn(async () => []);
    clientApiMock.getConfig = vi.fn(async () => {
      throw new Error('connection refused');
    });
    clientApiMock.getAuth = vi.fn(async () => {
      throw new Error('connection refused');
    });
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'configure-model', sessionId: 's1' });
    });
  });

  it('non-auth failures keep the plain toast and produce no verdict', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40901);
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'hello' }))).resolves.toBe('rejected');

    expect(f.client.sendFailureVerdict.value).toBeNull();
    await vi.waitFor(() => {
      expect(f.client.warnings.value.length).toBeGreaterThan(0);
    });
  });

  it('skill activation 40112 surfaces login (the activation catch rides the same entry)', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.updateSession = vi.fn(async () => ({}));
    clientApiMock.activateSkill = vi.fn(async () => {
      throw authError(f, 40112, { provider_id: 'managed:kimi-code' });
    });

    await expect(f.client.activateSkill('agent-browser', 'do it')).resolves.toBe(false);

    expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'login', sessionId: 's1' });
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonApiTitle',
    });
  });

  it('skill activation 40113 toasts the default-model guidance like a plain send', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.updateSession = vi.fn(async () => ({}));
    clientApiMock.activateSkill = vi.fn(async () => {
      throw authError(f, 40113);
    });
    mockPassingGateRecheck();

    await expect(f.client.activateSkill('agent-browser', 'do it')).resolves.toBe(false);

    expectSendFailureNotice(f);
    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'ok', sessionId: 's1' });
    });
  });

  it('BTW 40111 on a custom provider surfaces configure-model', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.startBtw = vi.fn(async () => ({ agentId: 'agent-1' }));
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40111, { provider_id: 'openai' });
    });

    const opened = await f.client.openSideChatOn('s1');
    expect(opened.target?.agentId).toBe('agent-1');
    await expect(f.client.sendSideChatPromptOn('s1', 'agent-1', 'btw question')).resolves.toBe(false);

    expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'configure-model', sessionId: 's1' });
    expect(f.client.warnings.value).toHaveLength(1);
    expect(f.client.warnings.value[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonApiTitle',
    });
  });

  it('BTW 40113 toasts the default-model guidance like a plain send', async () => {
    const f = await freshFacade();
    await seedIdleSession(f);
    clientApiMock.startBtw = vi.fn(async () => ({ agentId: 'agent-1' }));
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113);
    });
    mockPassingGateRecheck();

    const opened = await f.client.openSideChatOn('s1');
    expect(opened.target?.agentId).toBe('agent-1');
    await expect(f.client.sendSideChatPromptOn('s1', 'agent-1', 'btw question')).resolves.toBe(false);

    expectSendFailureNotice(f);
    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'ok', sessionId: 's1' });
    });
  });
});

describe('the just-opened cold session model window', () => {
  it('suppresses the premature pick-model pill until the first agent frame arrives', async () => {
    const { client, models, sessions } = await freshFacade();
    stubEventConnection();
    models.setModels([MODEL]);
    sessions.setSessions([session('s1', '')]);

    void client.selectSession('s1');
    await vi.waitFor(() => expect(eventHandlers).toBeDefined());
    expect(client.chatGateVerdict.value).toBe('ok');

    emitMainAgentState('s1');
    await vi.waitFor(() => expect(client.chatGateVerdict.value).toBe('pick-model'));
  });

  it('ensureChatReady waits for the first agent frame before judging the resolution chain', async () => {
    const { client, models, sessions } = await freshFacade();
    stubEventConnection();
    clientApiMock.getAuth = vi.fn();
    models.setModels([MODEL]);
    sessions.setSessions([session('s1', '')]);

    void client.selectSession('s1');
    await vi.waitFor(() => expect(eventHandlers).toBeDefined());
    let settled = false;
    const gate = client.ensureChatReady().then((v) => {
      settled = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    emitMainAgentState('s1', 'openai/gpt-4o');
    await expect(gate).resolves.toBe('ok');
    expect(clientApiMock.getAuth).not.toHaveBeenCalled();
  });

  it('a draft-screen model pick does not leak into an existing session without a model', async () => {
    const { client, models, sessions } = await freshFacade();
    stubEventConnection();
    models.setModels([MODEL]);
    models.setDraftModel('openai/gpt-4o');
    sessions.setSessions([session('s1', '')]);

    void client.selectSession('s1');
    await vi.waitFor(() => expect(eventHandlers).toBeDefined());
    emitMainAgentState('s1');
    await vi.waitFor(() => expect(client.chatGateVerdict.value).toBe('pick-model'));

    sessions.setActiveSessionId(undefined);
    expect(client.chatGateVerdict.value).toBe('ok');
  });

  it('an older 40113 mapping does not overwrite a newer failure verdict', async () => {
    const f = await freshFacade();
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', 'openai/gpt-4o')]);
    f.sessions.setActiveSessionId('s1');
    let resolveModels!: (value: unknown) => void;
    clientApiMock.listModels = vi.fn(
      () => new Promise((resolve) => { resolveModels = resolve; }),
    );
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 1,
      managedProvider: { status: 'authenticated' },
    }));
    let call = 0;
    clientApiMock.submitPrompt = vi.fn(async () => {
      call += 1;
      if (call === 1) throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
      throw authError(f, 40111, { provider_id: 'managed:kimi-code' });
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'first' }))).resolves.toBe('rejected');
    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'second' }))).resolves.toBe('rejected');
    await vi.waitFor(() => expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'login', sessionId: 's1' }));
    resolveModels([MODEL]);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'login', sessionId: 's1' });
  });

  it('a non-auth failure does not preempt an in-flight 40113 mapping', async () => {
    const f = await freshFacade();
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', 'openai/gpt-4o')]);
    f.sessions.setActiveSessionId('s1');
    let resolveModels!: (value: unknown) => void;
    clientApiMock.listModels = vi.fn(
      () => new Promise((resolve) => { resolveModels = resolve; }),
    );
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: 'openai/gpt-4o' }));
    clientApiMock.getAuth = vi.fn(async () => {
      throw new Error('connection refused');
    });
    let call = 0;
    clientApiMock.submitPrompt = vi.fn(async () => {
      call += 1;
      if (call === 1) throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
      throw new Error('network down');
    });

    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'first' }))).resolves.toBe('rejected');
    await expect(f.client.sendPrompt(f.client.createPromptEnvelope({ text: 'second' }))).resolves.toBe('rejected');
    await vi.waitFor(() => expect(f.client.warnings.value.length).toBeGreaterThan(0));
    expect(f.client.sendFailureVerdict.value).toBeNull();
    resolveModels([MODEL]);
    await vi.waitFor(() => expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'pick-model', sessionId: 's1' }));
  });

  it('ensureChatReady keys its flight by the originating session', async () => {
    const f = await freshFacade();
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', ''), session('s2', '')]);
    void f.client.selectSession('s1');
    await vi.waitFor(() => expect(eventHandlers).toBeDefined());
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));
    clientApiMock.getAuth = vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null }));

    const gateA = f.client.ensureChatReady();
    f.sessions.setActiveSessionId('s2');
    const gateB = f.client.ensureChatReady();
    emitMainAgentState('s2', 'openai/gpt-4o');
    const raced = await Promise.race([
      gateB.then(() => 'settled' as const),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 200)),
    ]);
    expect(raced).toBe('settled');
    await expect(gateB).resolves.toBe('ok');

    let aSettled = false;
    void gateA.then(() => { aSettled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(aSettled).toBe(false);

    emitMainAgentState('s1', 'openai/gpt-4o');
    await expect(gateA).resolves.toBe('ok');
  });

  it('prompt 40113 recomputes against the FAILED session, not the foreground one', async () => {
    const f = await freshFacade();
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', 'openai/gpt-4o'), session('s2', '')]);
    f.sessions.setActiveSessionId('s1');
    clientApiMock.startBtw = vi.fn(async () => ({ agentId: 'agent-1' }));
    clientApiMock.listModels = vi.fn(async () => [MODEL]);
    clientApiMock.getConfig = vi.fn(async () => ({ providers: {}, defaultModel: null }));
    clientApiMock.getAuth = vi.fn(async () => ({
      modelsReady: false,
      providersCount: 1,
      managedProvider: { status: 'authenticated' },
    }));
    clientApiMock.submitPrompt = vi.fn(async () => {
      throw authError(f, 40113, { model_id: 'openai/gpt-4o' });
    });

    const opened = await f.client.openSideChatOn('s2');
    expect(opened.target?.agentId).toBe('agent-1');
    await expect(f.client.sendSideChatPromptOn('s2', 'agent-1', 'btw question')).resolves.toBe(false);

    await vi.waitFor(() => {
      expect(f.client.sendFailureVerdict.value).toEqual({ verdict: 'pick-model', sessionId: 's2' });
    });
  });

  it('setSessionModel switches the named session without touching the foreground one', async () => {
    const f = await freshFacade();
    stubEventConnection();
    f.models.setModels([MODEL]);
    f.sessions.setSessions([session('s1', 'openai/gpt-4o'), session('s2', '')]);
    f.sessions.setActiveSessionId('s1');
    clientApiMock.updateSession = vi.fn(async () => ({}));

    await expect(f.client.setSessionModel('s2', MODEL.id)).resolves.toBe(true);

    expect(clientApiMock.updateSession).toHaveBeenCalledWith(
      's2',
      expect.objectContaining({ model: MODEL.id }),
    );
    expect(clientApiMock.updateSession).not.toHaveBeenCalledWith('s1', expect.anything());
  });
});
