/**
 * `auth` domain tests — covers the `OAuthService` device-code orchestration
 * and its dependency on the `providers` config section, using a fake
 * `KimiOAuthToolkit` so no real network or token storage is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiOAuthToolkit } from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ErrorCodes, KimiError } from '#/errors';
import { IAuthSummaryService, IOAuthService } from '#/auth/auth';
import { AuthSummaryService, OAuthService } from '#/auth/authService';
import { PROVIDERS_SECTION, type ProvidersSection } from '#/auth/oauthSchemas';
import { IConfigService } from '#/config/config';

import { registerConfigServices } from '../config/stubs';
import { registerEnvironmentServices } from '../environment/stubs';
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
  let providers: ProvidersSection;
  let toolkit: FakeToolkit;

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
    ix = createServices(disposables, {
      base: [registerConfigServices, registerEnvironmentServices, registerTelemetryServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === PROVIDERS_SECTION ? providers : undefined) as IConfigService['get'],
          onDidChange: (() => ({ dispose: () => {} })) as IConfigService['onDidChange'],
        });
      },
    });
    toolkit = {
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue({ providerName: OAUTH_PROVIDER, ok: true }),
      getCachedAccessToken: vi.fn().mockResolvedValue(undefined),
      tokenProvider: vi.fn().mockReturnValue({ getAccessToken: async () => 'access-token' }),
    };
  });
  afterEach(() => disposables.dispose());

  function createService(): IOAuthService {
    return ix.createInstance(OAuthService, toolkit as unknown as KimiOAuthToolkit);
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

  it('startLogin rejects with AUTH_LOGIN_REQUIRED when provider has no oauth config', async () => {
    const svc = createService();
    await expect(svc.startLogin(NON_OAUTH_PROVIDER)).rejects.toThrow(KimiError);
    await expect(svc.startLogin(NON_OAUTH_PROVIDER)).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
    expect(toolkit.login).not.toHaveBeenCalled();
  });

  it('cancelLogin aborts a pending flow and marks it cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    toolkit.login.mockImplementation(async (_provider, options) => {
      capturedSignal = options.signal;
      options.onDeviceCode(deviceAuth);
      return new Promise(() => {});
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
      return new Promise(() => {});
    });
    const svc = createService();
    await svc.startLogin(OAUTH_PROVIDER);

    const result = await svc.logout(OAUTH_PROVIDER);
    expect(result).toEqual({ logged_out: true, provider: OAUTH_PROVIDER });
    expect(toolkit.logout).toHaveBeenCalledWith(
      OAUTH_PROVIDER,
      { storage: 'file', key: 'oauth/kimi-code' },
    );
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
});

describe('AuthSummaryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: ProvidersSection;
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
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === PROVIDERS_SECTION ? providers : undefined) as IConfigService['get'],
        });
        reg.definePartialInstance(IOAuthService, {
          status: oauthStatus as unknown as IOAuthService['status'],
        });
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createSummary(): IAuthSummaryService {
    return ix.createInstance(AuthSummaryService);
  }

  it('summarize reports status only for providers configured with oauth', async () => {
    oauthStatus.mockResolvedValue({ loggedIn: true, provider: OAUTH_PROVIDER });
    const result = await createSummary().summarize();
    expect(result).toEqual([{ loggedIn: true, provider: OAUTH_PROVIDER }]);
    expect(oauthStatus).toHaveBeenCalledWith(OAUTH_PROVIDER);
    expect(oauthStatus).not.toHaveBeenCalledWith(NON_OAUTH_PROVIDER);
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
