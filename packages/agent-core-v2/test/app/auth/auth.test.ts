/**
 * `auth` domain tests — covers the `OAuthService` device-code orchestration,
 * its dependency on the `provider` domain, and the managed OAuth provider
 * model refresh, using a fake `IOAuthToolkit` so no real network or token
 * storage is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  clearManagedKimiCodeConfig,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IAuthSummaryService, IOAuthService, IOAuthToolkit } from '#/app/auth/auth';
import { AuthSummaryService, OAuthService } from '#/app/auth/authService';
import {
  SERVICES_SECTION,
  servicesFromToml,
  servicesToToml,
  ServicesConfigSchema,
  type ServicesConfig,
} from '#/app/auth/configSection';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { WebSearchProviderService } from '#/app/auth/webSearch/webSearchService';
import { IAuthLegacyService } from '#/app/authLegacy/authLegacy';
import { AuthLegacyService } from '#/app/authLegacy/authLegacyService';
import { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { type DomainEvent, IEventService } from '#/app/event/event';
import { ILogService } from '#/_base/log/log';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { MODELS_SECTION } from '#/app/kosongConfig/configSection';
import { IProviderService, type ProviderConfig, type ProvidersChangedEvent } from '#/kosong/provider/provider';

// Side-effect registration: the OAuth-catalog verdict
// (`isOAuthCatalogProvider`) answers through the provider-definition registry.
import '#/kosong/provider/providers/kimi/kimi.contrib';

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

const EXAMPLE_COM_SCOPED_REF = {
  storage: 'file',
  key: resolveKimiCodeOAuthKey({ baseUrl: 'https://api.example.com' }),
  oauthHost: 'https://auth.kimi.com',
} as const;

const ENV_SCOPED_REF = {
  storage: 'file',
  key: resolveKimiCodeOAuthKey({
    oauthHost: 'https://env-auth.example.com',
    baseUrl: 'https://env-api.example.com/coding/v1',
  }),
  oauthHost: 'https://env-auth.example.com',
} as const;

interface FakeToolkit {
  readonly login: Mock<(...args: any[]) => any>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly getCachedAccessToken: ReturnType<typeof vi.fn>;
  readonly tokenProvider: ReturnType<typeof vi.fn>;
  readonly getManagedUsage: ReturnType<typeof vi.fn>;
}

describe('OAuthService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let services: Record<string, unknown> | undefined;
  let defaultModel: string | undefined;
  let thinking: { enabled?: boolean; effort?: string } | undefined;
  let toolkit: FakeToolkit;
  let providerSet: ReturnType<typeof vi.fn>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;
  let events: DomainEvent[];
  let providerChangedEmitter: Emitter<ProvidersChangedEvent>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providerChangedEmitter = new Emitter<ProvidersChangedEvent>();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    providerSet = vi.fn(async (name: string, config: ProviderConfig) => {
      providers = { ...providers, [name]: config };
    });
    models = {};
    services = undefined;
    defaultModel = undefined;
    thinking = undefined;
    configSet = vi.fn(async (domain: string, value: unknown) => {
      if (domain === 'defaultModel') {
        defaultModel = value as string | undefined;
        return;
      }
      if (domain === 'thinking') {
        thinking = value as { enabled?: boolean; effort?: string } | undefined;
        return;
      }
      throw new Error(`unexpected config set: ${domain}`);
    });
    configReplace = vi.fn(async (domain: string, value: unknown) => {
      if (domain === 'providers') {
        providers = value as Record<string, ProviderConfig>;
        return;
      }
      if (domain === 'models') {
        models = value as Record<string, ModelRecord>;
        return;
      }
      if (domain === 'services') {
        services = value as Record<string, unknown> | undefined;
        return;
      }
      if (domain === 'defaultModel') {
        defaultModel = value as string | undefined;
        return;
      }
      if (domain === 'thinking') {
        thinking = value as { enabled?: boolean; effort?: string } | undefined;
        return;
      }
      throw new Error(`unexpected config replace: ${domain}`);
    });
    events = [];
    toolkit = {
      login: vi.fn<(...args: any[]) => any>(),
      logout: vi.fn().mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true }),
      getCachedAccessToken: vi.fn().mockResolvedValue(undefined),
      tokenProvider: vi.fn().mockReturnValue({ getAccessToken: async () => 'access-token' }),
      getManagedUsage: vi.fn().mockResolvedValue({ kind: 'error', message: 'not configured' }),
    };
    ix = createServices(disposables, {
      base: [registerBootstrapServices, registerTelemetryServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
          set: providerSet as unknown as IProviderService['set'],
          onDidChangeProviders: providerChangedEmitter.event as IProviderService['onDidChangeProviders'],
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
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
          onDidSectionChange: (() => ({ dispose: () => { } })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(ILogService, {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        });
        reg.definePartialInstance(IEventService, {
          publish: (event: DomainEvent) => events.push(event),
          subscribe: () => ({ dispose: () => {} }),
        });
        reg.defineInstance(IOAuthToolkit, toolkit as unknown as IOAuthToolkit);
        reg.define(IOAuthService, OAuthService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function createService(): IOAuthService {
    return ix.get(IOAuthService);
  }

  function configBacking(): Record<string, unknown> {
    return { providers, models, services, defaultModel, thinking };
  }

  function stubManagedModelsFetch(): ReturnType<typeof vi.fn> {
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
    return fetchMock;
  }

  it('startLogin resolves a device-code flow and flips to authenticated on success', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
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
      expect.objectContaining({
        oauthRef: EXAMPLE_COM_SCOPED_REF,
        baseUrl: 'https://api.example.com',
        oauthHost: undefined,
      }),
    );

    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));
  });

  it('provisions the managed provider through the provider service after login', async () => {
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
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
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
  });

  it('startLogin resolves an env-scoped oauth ref for the managed provider without oauth config', async () => {
    providers[OAUTH_PROVIDER] = { type: 'kimi', baseUrl: 'https://api.example.com' };
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: EXAMPLE_COM_SCOPED_REF,
        baseUrl: 'https://api.example.com',
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
  });

  it('startLogin reuses the configured oauth ref when it matches the login environment', async () => {
    providers[OAUTH_PROVIDER] = {
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      oauth: { storage: 'file', key: 'oauth/kimi-code' },
    };
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: { storage: 'file', key: 'oauth/kimi-code' },
        baseUrl: 'https://api.kimi.com/coding/v1',
      }),
    );
  });

  it('startLogin honors KIMI_CODE_BASE_URL / KIMI_CODE_OAUTH_HOST for the login environment', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env-api.example.com/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://env-auth.example.com');
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    expect(toolkit.login).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        oauthRef: ENV_SCOPED_REF,
        baseUrl: 'https://env-api.example.com/coding/v1',
        oauthHost: 'https://env-auth.example.com',
      }),
    );
    await flush();
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://env-api.example.com/coding/v1',
        oauth: ENV_SCOPED_REF,
      }),
    );
  });

  it('resolves the runtime credential slot to the env environment after an env-scoped login', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://env-api.example.com/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://env-auth.example.com');
    stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));

    await svc.status(OAUTH_PROVIDER);
    expect(toolkit.getCachedAccessToken).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        key: resolveKimiCodeOAuthKey({
          oauthHost: 'https://env-auth.example.com',
          baseUrl: 'https://env-api.example.com/coding/v1',
        }),
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

  it('startLogin returns authenticated when login resolves without issuing a device code (already-authenticated fast path)', async () => {
    const fetchMock = stubManagedModelsFetch();
    toolkit.login.mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true });
    const svc = createService();

    const start = await svc.startLogin(OAUTH_PROVIDER);
    expect(start).toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'authenticated',
      flow_id: expect.any(String),
    });
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
  });

  it('startLogin returns authenticated when model refresh fails on the already-authenticated fast path', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
    vi.stubGlobal('fetch', fetchMock);
    toolkit.login.mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true });
    const svc = createService();

    await expect(svc.startLogin(OAUTH_PROVIDER)).resolves.toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'authenticated',
      flow_id: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(configReplace).not.toHaveBeenCalledWith('defaultModel', expect.any(String));
  });

  it('keeps a device-code login authenticated when model fetch is unavailable after authorization', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network disabled in test'));
    vi.stubGlobal('fetch', fetchMock);
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();

    await expect(svc.startLogin(OAUTH_PROVIDER)).resolves.toMatchObject({
      provider: OAUTH_PROVIDER,
      status: 'pending',
    });
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(configReplace).not.toHaveBeenCalledWith('defaultModel', expect.any(String));
  });

  it('refreshes managed models and sets the default model after a device-code login succeeds', async () => {
    const fetchMock = stubManagedModelsFetch();
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return Promise.resolve({ providerName: OAUTH_PROVIDER, ok: true });
    });
    const svc = createService();

    await svc.startLogin(OAUTH_PROVIDER);
    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('authenticated'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(providerSet).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      expect.objectContaining({
        type: 'kimi',
        oauth: EXAMPLE_COM_SCOPED_REF,
      }),
    );
    expect(configReplace).toHaveBeenCalledWith(
      'models',
      expect.objectContaining({
        'kimi-code/kimi-k2': expect.objectContaining({ model: 'kimi-k2' }),
      }),
    );
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
  });

  it('keeps an in-flight OAuth flow alive when unrelated providers change', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: ['other-provider'], removed: [], changed: [] });

    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');
  });

  it('aborts an in-flight OAuth flow when its provider is removed from config', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: [], removed: [OAUTH_PROVIDER], changed: [] });

    const flow = svc.getFlow(OAUTH_PROVIDER);
    expect(flow?.status).toBe('cancelled');
    expect(flow?.error_message).toBe('Provider configuration changed during login.');
  });

  it('marks an in-flight OAuth flow cancelled (not vanished) when its provider config changes', async () => {
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    providerChangedEmitter.fire({ added: [], removed: [], changed: [OAUTH_PROVIDER] });

    const flow = svc.getFlow(OAUTH_PROVIDER);
    expect(flow?.status).toBe('cancelled');
    expect(flow?.error_message).toBe('Provider configuration changed during login.');
  });

  it('does not finalize a login whose provider changed after toolkit.login resolved', async () => {
    let resolveLogin!: (value: { providerName: string; ok: true }) => void;
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise((resolve) => {
        resolveLogin = resolve;
      });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);
    expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('pending');

    resolveLogin({ providerName: OAUTH_PROVIDER, ok: true });
    providerChangedEmitter.fire({ added: [], removed: [], changed: [OAUTH_PROVIDER] });

    await vi.waitFor(() => expect(svc.getFlow(OAUTH_PROVIDER)?.status).toBe('cancelled'));
  });

  it('cancelLogin aborts a pending flow and marks it cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    toolkit.login.mockImplementation((_provider, options) => {
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
    toolkit.login.mockImplementation((_provider, options) => {
      options.onDeviceCode(deviceAuth);
      return new Promise(() => { });
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.logout(OAUTH_PROVIDER);
    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(toolkit.logout).toHaveBeenCalledWith(OAUTH_PROVIDER, EXAMPLE_COM_SCOPED_REF);
    expect(configReplace).toHaveBeenCalledWith('providers', {
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    });
  });

  it('logout removes managed provider models and dangling defaults', async () => {
    models = {
      'kimi-code/kimi-k2': {
        provider: OAUTH_PROVIDER,
        model: 'kimi-k2',
        maxContextSize: 131072,
      },
      'custom-default': {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4o',
        maxContextSize: 8192,
      },
    };
    defaultModel = 'kimi-code/kimi-k2';
    thinking = { enabled: true };
    const svc = createService();

    const result = await svc.logout(OAUTH_PROVIDER);

    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(configReplace).toHaveBeenCalledWith('providers', {
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    });
    expect(configReplace).toHaveBeenCalledWith('models', {
      'custom-default': {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4o',
        maxContextSize: 8192,
      },
    });
    expect(configReplace).toHaveBeenCalledWith('defaultModel', undefined);
    expect(configReplace).toHaveBeenCalledWith('thinking', undefined);
  });

  it('logout removes managed web services while preserving unrelated services', async () => {
    services = ServicesConfigSchema.parse({
      moonshotSearch: {
        baseUrl: 'https://api.example.com/search',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      moonshotFetch: {
        baseUrl: 'https://api.example.com/fetch',
        apiKey: '',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      customService: {
        baseUrl: 'https://service.example.com',
      },
    });
    const svc = createService();

    await expect(svc.logout(OAUTH_PROVIDER)).resolves.toEqual({
      logged_out: true,
      provider: OAUTH_PROVIDER,
    });

    expect(configReplace).toHaveBeenCalledWith('services', {
      customService: {
        baseUrl: 'https://service.example.com',
      },
    });
  });

  it('logout surfaces managed provider cleanup write failures', async () => {
    const failure = new Error('config write failed');
    configReplace.mockRejectedValueOnce(failure);
    const svc = createService();

    await expect(svc.logout(OAUTH_PROVIDER)).rejects.toThrow('config write failed');
    expect(toolkit.logout).toHaveBeenCalledWith(OAUTH_PROVIDER, EXAMPLE_COM_SCOPED_REF);
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
    const provider = svc.resolveTokenProvider(NON_OAUTH_PROVIDER, { storage: 'file', key: 'k' });
    expect(provider).toEqual({ getAccessToken: expect.any(Function) });
    expect(toolkit.tokenProvider).toHaveBeenCalledWith(NON_OAUTH_PROVIDER, {
      storage: 'file',
      key: 'k',
    });
  });

  it('resolveTokenProvider re-derives the managed provider oauth ref from the current base url', () => {
    const svc = createService();
    svc.resolveTokenProvider(OAUTH_PROVIDER, { storage: 'file', key: 'stale-key' });
    const expectedRef = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: 'https://api.example.com',
      configuredOAuthRef: { storage: 'file', key: 'stale-key' },
    }).oauthRef;
    expect(toolkit.tokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, expectedRef);
  });

  it('getManagedUsage resolves the managed runtime auth and delegates to the toolkit', async () => {
    const usage = { kind: 'ok' as const, summary: null, limits: [], extraUsage: null };
    toolkit.getManagedUsage.mockResolvedValue(usage);
    const svc = createService();

    await expect(svc.getManagedUsage(OAUTH_PROVIDER)).resolves.toBe(usage);
    expect(toolkit.getManagedUsage).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      oauthRef: EXAMPLE_COM_SCOPED_REF,
      baseUrl: 'https://api.example.com',
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
    expect(events).toEqual([]);
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
    expect(configReplace).toHaveBeenCalledWith('defaultModel', 'kimi-code/kimi-k2');
    expect(configReplace).toHaveBeenCalledWith('thinking', { enabled: true });
    expect(events).toEqual([
      {
        type: 'event.model_catalog.changed',
        payload: result,
      },
    ]);
  });

  it('serializes concurrent refreshOAuthProviderModels runs so they never overlap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {
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
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = createService();

    await Promise.all([svc.refreshOAuthProviderModels(), svc.refreshOAuthProviderModels()]);

    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('WebSearchProviderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let servicesConfig: ServicesConfig | undefined;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    servicesConfig = undefined;
    resolveTokenProvider = vi
      .fn()
      .mockReturnValue({ getAccessToken: async () => 'access-token' });
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider:
            resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        reg.definePartialInstance(IHostRequestHeaders, {
          headers: {
            'User-Agent': 'kimi-code-cli/test',
            'X-Msh-Device-Id': 'device-test',
          },
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === SERVICES_SECTION ? servicesConfig : undefined) as IConfigService['get'],
        });
        reg.define(IWebSearchProviderService, WebSearchProviderService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  function createService(): IWebSearchProviderService {
    return ix.get(IWebSearchProviderService);
  }

  it('returns undefined when the managed provider is not configured', () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('returns undefined when the managed provider is not an OAuth kimi provider', () => {
    providers = { [OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('returns undefined when the oauth service yields no token provider', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    resolveTokenProvider.mockReturnValue(undefined);
    expect(createService().getWebSearchProvider()).toBeUndefined();
  });

  it('builds a search provider from the managed provider oauth ref', () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    expect(createService().getWebSearchProvider()).not.toBeUndefined();
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('searches against /search with the OAuth access token, host identity headers, and custom headers', async () => {
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://api.example.com/v1/',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        search_results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    const results = await provider!.search('hello');

    expect(results).toEqual([
      { title: 'Title', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-token');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
    expect(JSON.parse(init.body as string)).toEqual({ text_query: 'hello' });
  });

  it('builds a search provider from the services.moonshot_search api_key config', async () => {
    servicesConfig = {
      moonshotSearch: {
        baseUrl: 'https://search.example.com/search',
        apiKey: 'search-key',
        customHeaders: { 'X-Custom': 'yes' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        search_results: [{ title: 'Title', url: 'https://example.com', snippet: 'Snippet' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
    const results = await provider!.search('hello');

    expect(results).toEqual([
      { title: 'Title', url: 'https://example.com', snippet: 'Snippet' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://search.example.com/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer search-key');
    expect(headers['User-Agent']).toBe('kimi-code-cli/test');
    expect(headers['X-Msh-Device-Id']).toBe('device-test');
    expect(headers['X-Custom']).toBe('yes');
  });

  it('prefers the services.moonshot_search config over the managed oauth provider', async () => {
    servicesConfig = {
      moonshotSearch: { baseUrl: 'https://config.example.com/search', apiKey: 'config-key' },
    };
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        baseUrl: 'https://managed.example.com/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ search_results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    await provider!.search('hello');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://config.example.com/search');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer config-key');
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });

  it('builds a search provider from the services.moonshot_search oauth ref', async () => {
    servicesConfig = {
      moonshotSearch: {
        baseUrl: 'https://search.example.com/search',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ search_results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createService().getWebSearchProvider();
    expect(provider).not.toBeUndefined();
    expect(resolveTokenProvider).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
    await provider!.search('hello');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer access-token');
  });

  it('returns undefined when services.moonshot_search has no baseUrl and no managed oauth', () => {
    servicesConfig = { moonshotSearch: { apiKey: 'search-key' } };
    expect(createService().getWebSearchProvider()).toBeUndefined();
    expect(resolveTokenProvider).not.toHaveBeenCalled();
  });
});

describe('services config section', () => {
  it('registers the services section and validates its schema', () => {
    const registry = new ConfigRegistry();

    expect(registry.getSection(SERVICES_SECTION)).toBeDefined();
    expect(
      registry.validate(SERVICES_SECTION, {
        moonshotSearch: { baseUrl: 'https://api.example.com/search', apiKey: 'search-key' },
        moonshotFetch: { baseUrl: 'https://api.example.com/fetch' },
        customService: { baseUrl: 'https://service.example.com', retries: 3 },
      }),
    ).toEqual({
      moonshotSearch: { baseUrl: 'https://api.example.com/search', apiKey: 'search-key' },
      moonshotFetch: { baseUrl: 'https://api.example.com/fetch' },
      customService: { baseUrl: 'https://service.example.com', retries: 3 },
    });
    expect(() =>
      registry.validate(SERVICES_SECTION, { moonshotSearch: { baseUrl: 42 } }),
    ).toThrow();
  });

  it('maps services from TOML snake_case to camelCase', () => {
    expect(
      servicesFromToml({
        moonshot_search: {
          base_url: 'https://api.example.com/search',
          api_key: 'search-key',
          custom_headers: { 'X-Search': '1' },
          oauth: { storage: 'file', key: 'oauth/kimi-code', oauth_host: 'https://auth.example.com' },
        },
        moonshot_fetch: { base_url: 'https://api.example.com/fetch', api_key: 'fetch-key' },
      }),
    ).toEqual({
      moonshotSearch: {
        baseUrl: 'https://api.example.com/search',
        apiKey: 'search-key',
        customHeaders: { 'X-Search': '1' },
        oauth: { storage: 'file', key: 'oauth/kimi-code', oauthHost: 'https://auth.example.com' },
      },
      moonshotFetch: { baseUrl: 'https://api.example.com/fetch', apiKey: 'fetch-key' },
    });
  });

  it('maps services back to TOML snake_case, preserving unknown entries', () => {
    expect(
      servicesToToml(
        {
          moonshotSearch: {
            baseUrl: 'https://api.example.com/search',
            apiKey: 'search-key',
            customHeaders: { 'X-Search': '1' },
            oauth: {
              storage: 'file',
              key: 'oauth/kimi-code',
              oauthHost: 'https://auth.example.com',
            },
          },
        },
        { custom_service: { base_url: 'https://service.example.com' } },
      ),
    ).toEqual({
      moonshot_search: {
        base_url: 'https://api.example.com/search',
        api_key: 'search-key',
        custom_headers: { 'X-Search': '1' },
        oauth: { storage: 'file', key: 'oauth/kimi-code', oauth_host: 'https://auth.example.com' },
      },
      custom_service: { base_url: 'https://service.example.com' },
    });
  });

  it('preserves unknown services when managed services are removed', () => {
    const rawServices = {
      moonshot_search: {
        base_url: 'https://api.example.com/search',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      moonshot_fetch: {
        base_url: 'https://api.example.com/fetch',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      custom_service: {
        base_url: 'https://service.example.com',
        retries: 3,
      },
    };
    const services = ServicesConfigSchema.parse(servicesFromToml(rawServices));
    const config = { providers: {}, services };

    clearManagedKimiCodeConfig(config);

    expect(servicesToToml(config.services, rawServices)).toEqual({
      custom_service: {
        base_url: 'https://service.example.com',
        retries: 3,
      },
    });
  });
});

describe('AuthSummaryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelRecord>;
  let defaultModel: string | undefined;
  let oauthStatus: ReturnType<typeof vi.fn>;
  let getCachedAccessToken: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {
      [OAUTH_PROVIDER]: {
        type: 'kimi',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    models = {
      kimi: {
        provider: OAUTH_PROVIDER,
        model: 'kimi-k2',
        protocol: 'openai',
        maxContextSize: 128000,
      },
      openai: {
        provider: NON_OAUTH_PROVIDER,
        model: 'gpt-4.1',
        protocol: 'openai',
        maxContextSize: 128000,
      },
    };
    defaultModel = 'kimi';
    oauthStatus = vi.fn();
    getCachedAccessToken = vi.fn().mockResolvedValue(undefined);
    reload = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
        });
        reg.definePartialInstance(IModelService, {
          get: ((id: string) => models[id]) as IModelService['get'],
          list: (() => models) as IModelService['list'],
          getDefaultModel: (() => defaultModel) as IModelService['getDefaultModel'],
        });
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => {
            if (domain === MODELS_SECTION) return models;
            if (domain === 'defaultModel') return defaultModel;
            return undefined;
          }) as IConfigService['get'],
          reload: reload as unknown as IConfigService['reload'],
          onDidChangeConfiguration: (() => ({ dispose: () => { } })) as IConfigService['onDidChangeConfiguration'],
          onDidSectionChange: (() => ({ dispose: () => { } })) as IConfigService['onDidSectionChange'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
          getCachedAccessToken: getCachedAccessToken as unknown as IOAuthService['getCachedAccessToken'],
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
    oauthStatus.mockImplementation((name: string) => {
      if (name === OTHER_OAUTH) throw new Error('No OAuth manager configured');
      return { loggedIn: true, provider: name };
    });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).toHaveBeenCalledWith(OTHER_OAUTH);
  });

  it('ensureReady throws provisioning_required when provider-backed config has no providers', async () => {
    providers = {};
    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.provisioning_required',
      details: undefined,
    });
    expect(oauthStatus).not.toHaveBeenCalled();
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws model_not_resolved when the default model alias is missing', async () => {
    defaultModel = 'missing';

    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.model_not_resolved',
      details: { model_id: 'missing' },
    });
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws model_not_resolved when the model provider is missing', async () => {
    delete providers[OAUTH_PROVIDER];

    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.model_not_resolved',
      details: { model_id: 'kimi', provider_id: OAUTH_PROVIDER },
    });
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady throws token_missing when an oauth provider has no cached token', async () => {
    await expect(createSummary().ensureReady()).rejects.toMatchObject({
      code: 'auth.token_missing',
      details: { provider_id: OAUTH_PROVIDER },
    });
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('ensureReady propagates cached token read failures', async () => {
    getCachedAccessToken.mockRejectedValue(new Error('token store unreadable'));

    await expect(createSummary().ensureReady()).rejects.toThrow('token store unreadable');
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });

  it('ensureReady accepts provider api keys', async () => {
    await expect(createSummary().ensureReady('openai')).resolves.toBeUndefined();
    expect(getCachedAccessToken).not.toHaveBeenCalled();
  });

  it('ensureReady accepts cached oauth tokens', async () => {
    getCachedAccessToken.mockResolvedValue('access-token');
    await expect(createSummary().ensureReady('kimi')).resolves.toBeUndefined();
    expect(getCachedAccessToken).toHaveBeenCalledWith(OAUTH_PROVIDER, {
      storage: 'file',
      key: 'oauth/kimi-code',
    });
  });
});

describe('AuthLegacyService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let defaultModel: string | undefined;
  let oauthStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    defaultModel = undefined;
    oauthStatus = vi.fn();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IProviderService, {
          list: (() => providers) as IProviderService['list'],
        });
        reg.definePartialInstance(IModelService, {
          ready: Promise.resolve(),
          getDefaultModel: (() => defaultModel) as IModelService['getDefaultModel'],
        });
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: ((domain: string) =>
            domain === 'defaultModel' ? defaultModel : undefined) as IConfigService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
        });
        reg.define(IAuthLegacyService, AuthLegacyService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createService(): IAuthLegacyService {
    return ix.get(IAuthLegacyService);
  }

  it('returns an empty snapshot when no providers are configured', async () => {
    await expect(createService().get()).resolves.toEqual({
      ready: false,
      providers_count: 0,
      default_model: null,
      managed_provider: null,
    });
    expect(oauthStatus).not.toHaveBeenCalled();
  });

  it('counts every configured provider, not only oauth ones', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
      [NON_OAUTH_PROVIDER]: { type: 'openai', apiKey: 'sk-test' },
    };
    oauthStatus.mockResolvedValue({ loggedIn: false });
    const summary = await createService().get();
    expect(summary.providers_count).toBe(2);
  });

  it('reflects the configured default model', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    defaultModel = 'k2';
    const summary = await createService().get();
    expect(summary.default_model).toBe('k2');
    expect(summary.managed_provider).toBeNull();
    expect(summary.ready).toBe(true);
  });

  it('is not ready when a provider exists but no default model is set', async () => {
    providers = { [NON_OAUTH_PROVIDER]: { type: 'kimi', apiKey: 'sk-test' } };
    const summary = await createService().get();
    expect(summary.providers_count).toBe(1);
    expect(summary.default_model).toBeNull();
    expect(summary.managed_provider).toBeNull();
    expect(summary.ready).toBe(false);
  });

  it('surfaces managed_provider.unauthenticated when configured without a cached token', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    oauthStatus.mockResolvedValue({ loggedIn: false });
    const summary = await createService().get();
    expect(summary.managed_provider).toEqual({
      name: OAUTH_PROVIDER,
      status: 'unauthenticated',
    });
    expect(summary.ready).toBe(false);
  });

  it('surfaces managed_provider.authenticated when a cached token exists', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    defaultModel = 'k2';
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    const summary = await createService().get();
    expect(summary.managed_provider).toEqual({
      name: OAUTH_PROVIDER,
      status: 'authenticated',
    });
    expect(summary.ready).toBe(true);
  });

  it('treats a throwing oauth status as unauthenticated', async () => {
    providers = {
      [OAUTH_PROVIDER]: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
    };
    oauthStatus.mockRejectedValue(new Error('token storage unavailable'));
    await expect(createService().get()).resolves.toMatchObject({
      managed_provider: { name: OAUTH_PROVIDER, status: 'unauthenticated' },
    });
  });
});
