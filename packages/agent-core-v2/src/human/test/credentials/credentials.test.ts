import { describe, expect, it } from 'vitest';

import {
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#/credentials/credentials';

describe('createStaticCredentialProvider', () => {
  it('resolves the static api key and never recovers', async () => {
    const provider = createStaticCredentialProvider('sk-1');
    expect(await provider.resolve()).toEqual({ apiKey: 'sk-1' });
    expect(provider.canRecover).toBeUndefined();
    expect(provider.invalidate).toBeUndefined();
  });

  it('resolves undefined for missing or blank keys', async () => {
    expect(await createStaticCredentialProvider(undefined).resolve()).toBeUndefined();
    expect(await createStaticCredentialProvider('   ').resolve()).toBeUndefined();
  });
});

describe('createOAuthCredentialProvider', () => {
  it('refreshes with force on invalidate and consumes the refresh on the next resolve', async () => {
    const calls: (boolean | undefined)[] = [];
    const provider = createOAuthCredentialProvider((options) => {
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
    const provider = createOAuthCredentialProvider((options) => {
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
    const provider = createOAuthCredentialProvider((options) => {
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
    const provider = createOAuthCredentialProvider(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('login required')) : Promise.resolve('tok');
    });

    provider.invalidate?.();

    await expect(provider.resolve()).rejects.toThrow('login required');
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'tok' });
  });

  it('recovers only from 401 errors', () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve('tok'));
    expect(provider.canRecover?.(Object.assign(new Error('x'), { status: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 401 }))).toBe(true);
    expect(provider.canRecover?.(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(provider.canRecover?.(new Error('boom'))).toBe(false);
  });

  it('resolves undefined when the token source has no token', async () => {
    const provider = createOAuthCredentialProvider(() => Promise.resolve(undefined));
    await expect(provider.resolve()).resolves.toBeUndefined();
  });
});
