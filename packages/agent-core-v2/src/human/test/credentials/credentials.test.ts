import { describe, expect, it } from 'vitest';

import {
  applyCredential,
  attemptWithCredentialRecovery,
  oauthCredentials,
  resolveModelCredentials,
  staticCredentials,
} from '#/credentials/credentials';
import type { LlmModel } from '#/llm/model';

const MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  apiKey: 'base-key',
  defaultHeaders: { 'x-base': '1' },
};

describe('staticCredentials', () => {
  it('resolves the static api key and never recovers', async () => {
    const provider = staticCredentials('sk-1');
    expect(await provider.resolve()).toEqual({ apiKey: 'sk-1' });
    expect(provider.canRecover).toBeUndefined();
    expect(provider.invalidate).toBeUndefined();
  });

  it('resolves undefined for missing or blank keys', async () => {
    expect(await staticCredentials(undefined).resolve()).toBeUndefined();
    expect(await staticCredentials('   ').resolve()).toBeUndefined();
  });
});

describe('oauthCredentials', () => {
  it('forces a refresh only on the resolve immediately after invalidate', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = oauthCredentials((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    await provider.resolve();
    await provider.resolve();
    provider.invalidate?.();
    await provider.resolve();
    await provider.resolve();

    expect(calls).toEqual([undefined, undefined, true, undefined]);
  });

  it('recovers only from 401 errors', () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
  });

  it('resolves undefined when the token source has no token', async () => {
    const provider = oauthCredentials(() => Promise.resolve(undefined));
    await expect(provider.resolve()).resolves.toBeUndefined();
  });
});

describe('applyCredential / resolveModelCredentials', () => {
  it('returns the model unchanged when the credential is undefined', async () => {
    expect(applyCredential(MODEL, undefined)).toBe(MODEL);
    await expect(resolveModelCredentials(MODEL, undefined)).resolves.toBe(MODEL);
  });

  it('overrides the api key and merges headers', () => {
    const applied = applyCredential(MODEL, { apiKey: 'fresh', headers: { 'x-auth': 't' } });
    expect(applied.apiKey).toBe('fresh');
    expect(applied.defaultHeaders).toEqual({ 'x-base': '1', 'x-auth': 't' });
  });

  it('keeps the model api key when the credential carries none', () => {
    const applied = applyCredential(MODEL, { headers: { 'x-auth': 't' } });
    expect(applied.apiKey).toBe('base-key');
  });
});

describe('attemptWithCredentialRecovery', () => {
  it('returns the first attempt result without invalidating', async () => {
    let invalidated = 0;
    const provider = {
      resolve: () => undefined,
      canRecover: () => true,
      invalidate: () => {
        invalidated += 1;
      },
    };
    let attempts = 0;
    const result = await attemptWithCredentialRecovery(provider, () => {
      attempts += 1;
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(1);
    expect(invalidated).toBe(0);
  });

  it('invalidates and retries once on a recoverable error', async () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    const attempts: number[] = [];
    const result = await attemptWithCredentialRecovery(provider, () => {
      attempts.push(attempts.length);
      if (attempts.length === 1) {
        return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
      }
      return Promise.resolve('ok');
    });
    expect(result).toBe('ok');
    expect(attempts).toEqual([0, 1]);
  });

  it('rethrows non-recoverable errors without retrying', async () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    let attempts = 0;
    const failure = await attemptWithCredentialRecovery(provider, () => {
      attempts += 1;
      return Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }));
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('forbidden');
    expect(attempts).toBe(1);
  });

  it('propagates a second failure after the single retry', async () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    let attempts = 0;
    const failure = await attemptWithCredentialRecovery(provider, () => {
      attempts += 1;
      return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('unauthorized');
    expect(attempts).toBe(2);
  });
});
