import { describe, expect, it } from 'vitest';

import type { LlmErrorMessage } from '#/llm/errors';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import {
  credentialsRecovery,
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#/llm/builtin/requester/credentials';
import { applyCredential } from '#/llm/requester/credentials';
import { runLlmRequest } from '#/llm/requester/policy';
import { proposeFirst, type LlmRecovery, type LlmRecoveryContext, type LlmRecoveryRecord } from '#/llm/requester/recovery';
import type { LlmCredentialProvider, LlmRequester } from '#/llm/requester/requester';
import { isRetryableError } from '#/llm/requester/retry';

const MODEL: LlmModel = {
  provider: 'fake',
  model: 'fake-model',
  apiKey: 'base-key',
  defaultHeaders: { 'x-base': '1' },
};

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

describe('applyCredential', () => {
  it('returns the model unchanged when the credential is undefined', () => {
    expect(applyCredential(MODEL, undefined)).toBe(MODEL);
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
  appliedRecoveries: readonly LlmRecoveryRecord[] = [],
  credentialProvider?: LlmCredentialProvider,
): LlmRecoveryContext {
  return { error: error as LlmRecoveryContext['error'], messages: [], appliedRecoveries, credentialProvider };
}

const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
const forbidden = Object.assign(new Error('forbidden'), { status: 403 });

const REQUEST_MODEL: LlmModel = {
  provider: 'test',
  model: 'test',
  capability: UNKNOWN_CAPABILITY,
};

function statusError(
  kind: 'rate_limit' | 'status',
  statusCode: number,
  retryAfterMs: number | null = 1,
): LlmErrorMessage {
  return {
    kind,
    message: kind,
    statusCode,
    requestId: null,
    retryAfterMs,
    headers: null,
  };
}

function failingThenDone(failures: readonly LlmErrorMessage[]): LlmRequester {
  let calls = 0;
  return {
    generate: async (_config, _content, { onEvent }) => {
      const error = failures[calls];
      calls += 1;
      if (error !== undefined) {
        onEvent?.({ type: 'llm.failed.remote', error });
        return;
      }
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
      onEvent?.({ type: 'llm.done' });
    },
  };
}

describe('llm request policy', () => {
  it('keeps the default retryable table and only adds extras', () => {
    expect(isRetryableError({ kind: 'connection', message: 'x' })).toBe(true);
    expect(isRetryableError(statusError('rate_limit', 429))).toBe(true);
    expect(isRetryableError(statusError('status', 418))).toBe(false);
    expect(isRetryableError({ kind: 'unknown', message: 'x' })).toBe(false);
    expect(isRetryableError({ kind: 'unknown', message: 'x' }, [() => true])).toBe(true);
    expect(isRetryableError({ kind: 'syntax', message: 'x', code: 'internal' }, [() => true])).toBe(
      false,
    );
    expect(isRetryableError({ kind: 'abort', message: 'x' }, [() => true])).toBe(false);
    expect(isRetryableError(statusError('rate_limit', 429), [() => false])).toBe(true);
  });

  it('retries a rate-limit error then succeeds', async () => {
    const events: string[] = [];
    const result = await runLlmRequest(
      failingThenDone([statusError('rate_limit', 429)]),
      {
        config: { model: REQUEST_MODEL },
        content: { messages: [] },
        signal: new AbortController().signal,
      },
      {},
      (event) => {
        events.push(event.type);
      },
    );
    expect(result.type).toBe('done');
    expect(events).toContain('llm.retrying');
  });

  it('recovers credentials before retrying the same request', async () => {
    let invalidations = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'tok' }),
      canRecover: () => true,
      invalidate: () => {
        invalidations += 1;
      },
    };
    const events: string[] = [];
    const result = await runLlmRequest(
      failingThenDone([statusError('status', 401, null)]),
      {
        config: { model: REQUEST_MODEL },
        content: { messages: [] },
        signal: new AbortController().signal,
        credentialProvider: provider,
      },
      { recoveries: [credentialsRecovery] },
      (event) => {
        events.push(event.type);
      },
    );
    expect(result.type).toBe('done');
    expect(invalidations).toBe(1);
    expect(events).toContain('llm.recovering');
    expect(
      credentialsRecovery.propose(recoveryContext(unauthorized, [], provider)),
    ).toMatchObject({ strategy: 'credentials', action: 'refresh' });
    expect(credentialsRecovery.propose(recoveryContext(unauthorized))).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(unauthorized, [], createStaticCredentialProvider('sk-1')),
      ),
    ).toBeUndefined();
    expect(
      credentialsRecovery.propose(
        recoveryContext(forbidden, [], createOAuthCredentialProvider(() => Promise.resolve('tok'))),
      ),
    ).toBeUndefined();
  });

  it('proposeFirst takes the first valid recovery and skips a no-op override', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] }];
    const ctx: LlmRecoveryContext = {
      error: { kind: 'request_too_large', message: 'big', statusCode: 413, requestId: null, retryAfterMs: null, headers: null },
      messages,
      appliedRecoveries: [],
    };
    const skip: LlmRecovery = {
      propose: () => ({ strategy: 'skip', action: 'same', attemptMessageOverride: messages }),
    };
    const take: LlmRecovery = {
      propose: () => ({ strategy: 'take', action: 'ok' }),
    };
    expect(proposeFirst([skip, take], ctx)).toEqual({ strategy: 'take', action: 'ok' });
  });
});
