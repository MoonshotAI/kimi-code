import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KimiOAuthToolkit,
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from '@moonshot-ai/kimi-code-oauth';
import { APIStatusError } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCodes, KimiError, KimiForCodingProvider } from '#/index';

import { TEST_IDENTITY } from './test-identity';

describe('KimiForCodingProvider OAuth error mapping', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-for-coding-provider-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  function resolveAuth() {
    const provider = new KimiForCodingProvider({ homeDir, ...TEST_IDENTITY });
    return provider.resolveAuth('kimi-for-coding');
  }

  it('maps unauthorized token failures to auth.login_required', async () => {
    vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(
      new OAuthUnauthorizedError('No token for "kimi-code". Run /login to authenticate.'),
    );

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('refreshes credentials once when a request returns an authentication 401', async () => {
    vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockImplementation(
      (_provider, options) =>
        Promise.resolve(options?.force === true ? 'refreshed-token' : 'initial-token'),
    );
    const requestTokens: string[] = [];

    const auth = resolveAuth();
    const result = await auth(async (requestAuth) => {
      requestTokens.push(requestAuth.apiKey ?? '<missing>');
      if (requestTokens.length === 1) throw new APIStatusError(401, 'Unauthorized');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(requestTokens).toEqual(['initial-token', 'refreshed-token']);
  });

  it('surfaces a context-overflow 401 without refreshing credentials', async () => {
    const ensureFresh = vi
      .spyOn(KimiOAuthToolkit.prototype, 'ensureFresh')
      .mockResolvedValue('oauth-token');
    const overflow = new APIStatusError(401, 'example-256k supports only 256K context.');
    let requestCount = 0;

    const auth = resolveAuth();
    const caught = await auth(async () => {
      requestCount += 1;
      throw overflow;
    }).catch((error: unknown) => error);

    expect(caught).toBe(overflow);
    expect(requestCount).toBe(1);
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('maps transient token failures to provider.connection_error', async () => {
    const tokenErrors = [
      new OAuthConnectionError('OAuth request to https://example.test failed: fetch failed'),
      new RetryableRefreshError('Token refresh failed (HTTP 503).'),
    ];

    for (const tokenError of tokenErrors) {
      vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(tokenError);

      const auth = resolveAuth();
      const caught = await auth(async () => 'ok').catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(KimiError);
      expect(caught).toMatchObject({
        code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
        message: expect.stringContaining(tokenError.message),
        cause: tokenError,
      });

      vi.restoreAllMocks();
    }
  });

  it('rethrows unrecognized OAuth errors raw instead of guessing a category', async () => {
    const oauthError = new OAuthError('Token refresh failed (HTTP 400).');
    vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(oauthError);

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toBe(oauthError);
  });
});
