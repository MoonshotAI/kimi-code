import { describe, expect, it } from 'vitest';

import { kimiOAuthCredentialProvider } from '#/kimi-oauth/kimi-oauth';

describe('kimiOAuthCredentialProvider', () => {
  function createTokens() {
    const calls: (boolean | undefined)[] = [];
    return {
      calls,
      tokens: {
        getAccessToken: (options?: { readonly force?: boolean }) => {
          calls.push(options?.force);
          return Promise.resolve('access-token');
        },
      },
    };
  }

  it('resolves the access token from the token provider', async () => {
    const { calls, tokens } = createTokens();
    const provider = kimiOAuthCredentialProvider(tokens);

    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'access-token' });
    expect(calls).toEqual([undefined]);
  });

  it('forces a refresh only on the resolve immediately after invalidate', async () => {
    const { calls, tokens } = createTokens();
    const provider = kimiOAuthCredentialProvider(tokens);

    await provider.resolve();
    provider.invalidate?.();
    await provider.resolve();
    await provider.resolve();

    expect(calls).toEqual([undefined, true, undefined]);
  });

  it('recovers only from 401 errors', () => {
    const { tokens } = createTokens();
    const provider = kimiOAuthCredentialProvider(tokens);

    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
    expect(provider.canRecover?.('nope')).toBe(false);
  });
});
