import { describe, expect, it } from 'vitest';

import {
  applyCredential,
  credentialsRecovery,
  oauthCredentials,
  resolveModelCredentials,
  staticCredentials,
} from '#/credentials/credentials';
import type { LlmModel } from '#/llm/model';
import type { LlmRecoveryContext, LlmRecoveryRecord } from '#/llm/requester/recovery';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

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
  it('refreshes with force on invalidate and consumes the refresh on the next resolve', async () => {
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

  it('starts the forced refresh eagerly on invalidate, before the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = oauthCredentials((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();

    expect(calls).toEqual([true]);

    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('coalesces repeated invalidates into a single refresh', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = oauthCredentials((options) => {
      calls.push(options?.force);
      return Promise.resolve('tok');
    });

    provider.invalidate?.();
    provider.invalidate?.();
    await provider.resolve();

    expect(calls).toEqual([true]);
  });

  it('propagates a failed refresh to the consuming resolve and recovers afterwards', async () => {
    let calls = 0;
    const provider = oauthCredentials(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('login required')) : Promise.resolve('tok');
    });

    provider.invalidate?.();

    await expect(provider.resolve()).rejects.toThrow('login required');
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'tok' });
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

function recoveryContext(
  error: unknown,
  applied: readonly LlmRecoveryRecord[] = [],
  credentials?: LlmCredentialProvider,
): LlmRecoveryContext {
  return { error: error as LlmRecoveryContext['error'], messages: [], applied, credentials };
}

const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
const forbidden = Object.assign(new Error('forbidden'), { status: 403 });

describe('credentialsRecovery', () => {
  it('proposes a credentials refresh on a recoverable error', () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    expect(credentialsRecovery.propose(recoveryContext(unauthorized, [], provider))).toEqual({
      action: 'refresh',
      refreshCredentials: true,
    });
  });

  it('does not propose when the strategy was already applied', () => {
    const provider = oauthCredentials(() => Promise.resolve('tok'));
    const applied: LlmRecoveryRecord[] = [{ strategy: 'credentials', action: 'refresh' }];
    expect(credentialsRecovery.propose(recoveryContext(unauthorized, applied, provider))).toBeUndefined();
  });

  it('does not propose without recoverable credentials', () => {
    expect(credentialsRecovery.propose(recoveryContext(unauthorized))).toBeUndefined();
    expect(
      credentialsRecovery.propose(recoveryContext(unauthorized, [], staticCredentials('sk-1'))),
    ).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(forbidden, [], oauthCredentials(() => Promise.resolve('tok'))),
      ),
    ).toBeUndefined();
  });
});
