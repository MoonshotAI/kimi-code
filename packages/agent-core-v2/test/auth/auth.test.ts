/**
 * `auth` domain tests — covers the `OAuthService` device-code orchestration,
 * its dependency on the `provider` domain, and the managed OAuth provider
 * model refresh, using a fake `IOAuthToolkit` so no real network or token
 * storage is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ErrorCodes, KimiError } from '#/errors';
import { IAuthSummaryService, IOAuthService, IOAuthToolkit } from '#/auth/auth';
import { AuthSummaryService, OAuthService } from '#/auth/authService';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { type ModelAlias } from '#/model/model';
import { IProviderService, type ProviderConfig } from '#/provider/provider';

import { registerBootstrapServices } from '../bootstrap/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

const OAUTH_PROVIDER = 'managed:kimi-code';
const NON_OAUTH_PROVIDER = 'openai-main';

const deviceAuth = {
  userCode: 'ABCD-EFGH',
  deviceCode: 'device-code',
  verificationUri: 'https://example.com/device',
  verificationUriComplete: 'https://example.com/device?code=ABCD-EFGH',
  expiresIn: 900,
  interval: 5,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeToolkit {
  readonly login: ReturnType<typeof vi.fn>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly getCachedAccessToken: ReturnType<typeof vi.fn>;
  readonly tokenProvider: ReturnType<typeof vi.fn>;
}

describe('OAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelAlias>;
  let defaultModel: string | undefined;
  let defaultThinking: boolean | undefined;
  let toolkit: FakeToolkit;
  let providerSet: ReturnType<typeof vi.fn>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    providerSet = vi.fn().mockResolvedValue(undefined);
    models = {};
    defaultModel = undefined;
    defaultThinking = undefined;
    configSet = vi.fn().mockResolvedValue(undefined);
    configReplace = vi.fn().mockResolvedValue(undefined);
    toolkit = {
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true }),
      getCachedAccessToken: vi.fn().mockResolvedValue(undefined),
      tokenProvider: vi.fn().mockReturnValue({ getAccessToken: async () => 'access-token' }),
    };
    ix = createServices(disposables, {
      base: [registerBootstrapServices, registerTelemetryServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
          set: providerSet as unknown as IProviderService['set'],
          onDidChange: (() => ({ dispose: () => { } })) as IProviderService['onDidChange'],
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => configBacking()[domain]) as IConfigService['get'],
          inspect: ((domain: string) => ({
            value: configBacking()[domain],
            defaultValue: undefined,
            userValue: configBacking()[domain],
            memoryValue: undefined,
          })) as IConfigService['inspect'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          reload: vi.fn().mockResolvedValue(undefined) as unknown as IConfigService['reload'],
          onDidChange: (() => ({ dispose: () => { } })) as IConfigService['onDidChange'],
          onDidSectionChange: (() => ({ dispose: () => { } })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(ILogService, {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        });
        reg.defineInstance(IOAuthToolkit, toolkit as unknown as IOAuthToolkit);
        reg.define(IOAuthService, OAuthService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function createService(): IOAuthService {
    return ix.get(IOAuthService);
  }

  function configBacking(): Record<string, unknown> {
    return { providers, models, defaultModel, defaultThinking };
  }

  it('startLogin resolves a device-code flow and flips to authenticated on success', async () => {
    toolkit.login.mockImplementation(async (_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return { providerName: OAUTH_PROVIDER, ok: true };
    });
    const svc = createService();

    const start = await svc.startLogin(OAUTH_PROVIDER);
    expect(start).toMatchObject({
      provider: OAUTH_PROVIDER,
      verification_uri: deviceAuth.verificationUri,
      verification_uri_complete: deviceAuth.verificationUriComplete,
      user_code: deviceAuth.userCode,
      interval: deviceAuth.interval,
      status: 'pending',
    });
    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({ oauthRef: { storage: 'file', key: 'oauth/kimi-code' } }),
    );

    await flush();
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated');
  });

  it('provisions the managed provider through the provider service after login', async () => {
    toolkit.login.mockImplementation(async (_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return { providerName: OAUTH_PROVIDER, ok: true };
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    await flush();

    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      }),
    );
  });

  it('startLogin resolves a default oauth ref for the managed provider without oauth config', async () => {
    providers[OAUTH_PROVIDER] = { type: 'kimi', baseUrl: 'https://api.example.com' };
    toolkit.login.mockImplementation(async (_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return { providerName: OAUTH_PROVIDER, ok: true };
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: expect.objectContaining({ storage: 'file', key: expect.any(String) }),
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        oauth: expect.objectContaining({ storage: 'file', key: expect.any(String) }),
      }),
    );
  });

  it('startLogin rejects when the device authorization fails before onDeviceCode', async () => {
    toolkit.login.mockRejectedValue(new Error('device authorization request failed'));
    const svc = createService();
    await expect(svc.startLogin(OAUTH_PROVIDER)).rejects.toThrow(
      'device authorization request failed',
    );
  });

  it('startLogin rejects when login completes without issuing a device code', async () => {
    toolkit.login.mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true });
    const svc = createService();
    await expect(svc.startLogin(OAUTH_PROVIDER)).rejects.toThrow('already authenticated');
    expect(svc.getFlow(OAUTH_PROVIDER)).toBeUndefined();
  });

  it('cancelLogin aborts a pending flow and marks it cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    toolkit.login.mockImplementation(async (_provider, options) => {
      capturedSignal = options.signal;
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.cancelLogin(OAUTH_PROVIDER);
    expect(result).toEqual({ cancelled: true, status: 'cancelled' });
    expect(capturedSignal?.aborted).toBe(true);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('cancelled');
  });

  it('logout delegates to the toolkit and clears any pending flow', async () => {
    toolkit.login.mockImplementation(async (_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.logout(OAUTH_PROVIDER);
    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(toolkit.logout).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('status reports loggedIn based on the cached access token', async () => {
    const svc = createService();
    expect(await svc.status(OAUTH_PROVIDER)).toEqual({ loggedIn: false });

    toolkit.getCachedAccessToken.mockResolvedValue('cached-token');
    expect(await svc.status(OAUTH_PROVIDER)).toEqual({
      loggedIn: true,
      provider: OAUTH_PROVIDER,
    });
  });

  it('resolveTokenProvider delegates to the toolkit', () => {
    const svc = createService();
    const provider = svc.resolveTokenProvider(OAUTH_PROVIDER, { storage: 'file', key: 'k' });
    expect(provider).toEqual({ getAccessToken: expect.any(Function) });
    expect(toolkit.tokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'k',
    });
  });

  it('refreshOAuthProviderModels returns an empty result when no Kimi Code provider is configured', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    const svc = createService();

    await expect(svc.refreshOAuthProviderModels()).resolves.toEqual({
      changed: [],
      unchanged: [],
      failed: [],
    });
    expect(toolkit.tokenProvider).not.toHaveBeenCalled();
  });

  it('refreshOAuthProviderModels fetches models and writes back the changed sections', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'kimi-k2',
            context_length: 131072,
            supports_reasoning: true,
            display_name: 'Kimi K2',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = createService();

    const result = await svc.refreshOAuthProviderModels();

    expect(result.failed).toEqual([]);
    expect(result.changed).toEqual([
      {
        provider_id: OAUTH_PROVIDER,
        provider_name: 'Kimi Code',
        added: 1,
        removed: 0,
      },
    ]);
    expect(configReplace).toHaveBeenCalledWith(
      'providers',
      expect.objectContaining({ [OAUTH_PROVIDER]: expect.objectContaining({ type: 'kimi' }) }),
    );
    expect(configReplace).toHaveBeenCalledWith(
      'models',
      expect.objectContaining({
        'kimi-code/kimi-k2': expect.objectContaining({ model: 'kimi-k2' }),
      }),
    );
    expect(configSet).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
  });
});

describe('AuthSummaryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let oauthStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    oauthStatus = vi.fn();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          list: (() => providers) as IProviderService['list'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
        });
        reg.definePartialInstance(ILogService, {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        });
        reg.define(IAuthSummaryService, AuthSummaryService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createSummary(): IAuthSummaryService {
    return ix.get(IAuthSummaryService);
  }

  it('summarize reports status only for providers configured with oauth', async () => {
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).not.toHaveBeenCalledWith(NON_OAUTH_PROVIDER);
  });

  it('summarize skips providers whose status throws', async () => {
    const OTHER_OAUTH = 'kimi-code-anthropic';
    providers[OTHER_OAUTH] = {
      type: 'kimi',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    };
    oauthStatus.mockImplementation(async (name: string) => {
      if (name === OTHER_OAUTH) throw new Error('No OAuth manager configured');
      return { loggedIn: true, provider: name };
    });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).toHaveBeenCalledWith(OTHER_OAUTH);
  });

  it('ensureReady rejects with AUTH_LOGIN_REQUIRED when the provider is logged out', async () => {
    oauthStatus.mockResolvedValue({ loggedIn: false });
    await expect(createSummary().ensureReady(OAUTH_PROVIDER)).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('ensureReady resolves when the provider is logged in', async () => {
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    await expect(createSummary().ensureReady(OAUTH_PROVIDER)).resolves.toBeUndefined();
  });
});
