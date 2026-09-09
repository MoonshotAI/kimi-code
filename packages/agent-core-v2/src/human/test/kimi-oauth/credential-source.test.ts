import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import type { LlmRecoveryRecord } from '#/llm/requester/recovery';
import {
  credentialRecovery,
  credentialResolver,
  kimiOAuthCredentialSource,
  type CredentialSource,
} from '#/kimi-oauth/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function statusError(status: number): LlmErrorMessage<'status'> {
  return {
    kind: 'status',
    statusCode: status,
    message: `status ${status}`,
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

describe('credentialResolver', () => {
  it('resolves credentials before each attempt and forwards the resolved model', async () => {
    const source: CredentialSource = {
      resolve: (m) => ({ ...m, apiKey: 'token-1' }),
    };
    const resolver = credentialResolver(source);

    const resolved = await resolver.resolve(
      { config: { model }, messages: [] },
      { signal: new AbortController().signal },
    );

    expect(resolved?.config?.model).toEqual({ ...model, apiKey: 'token-1' });
  });

  it('returns undefined when the source keeps the same model', async () => {
    const resolver = credentialResolver({ resolve: (m) => m });

    const resolved = await resolver.resolve(
      { config: { model }, messages: [] },
      { signal: new AbortController().signal },
    );

    expect(resolved).toBeUndefined();
  });

  it('forces a refresh when the last attempt failed recoverably', async () => {
    const resolveOptions: unknown[] = [];
    const source: CredentialSource = {
      resolve: (m, options) => {
        resolveOptions.push(options);
        return { ...m, apiKey: options?.force === true ? 'token-2' : 'token-1' };
      },
      canRecover: (_m, error) => statusErrorStatus(error) === 401,
    };
    const resolver = credentialResolver(source);

    const first = await resolver.resolve(
      { config: { model }, messages: [] },
      { signal: new AbortController().signal },
    );
    const second = await resolver.resolve(
      { config: { model }, messages: [] },
      { signal: new AbortController().signal, lastAttemptError: statusError(401) },
    );

    expect(first?.config?.model.apiKey).toBe('token-1');
    expect(second?.config?.model.apiKey).toBe('token-2');
    expect(resolveOptions).toEqual([undefined, { force: true }]);
  });

  it('does not force a refresh when the last error is not recoverable', async () => {
    const resolveOptions: unknown[] = [];
    const source: CredentialSource = {
      resolve: (m, options) => {
        resolveOptions.push(options);
        return m;
      },
      canRecover: (_m, error) => statusErrorStatus(error) === 401,
    };
    const resolver = credentialResolver(source);

    await resolver.resolve(
      { config: { model }, messages: [] },
      { signal: new AbortController().signal, lastAttemptError: statusError(500) },
    );

    expect(resolveOptions).toEqual([undefined]);
  });
});

describe('credentialRecovery', () => {
  function propose(
    source: CredentialSource,
    error: LlmErrorMessage<'status'>,
    applied: readonly LlmRecoveryRecord[] = [],
  ) {
    return credentialRecovery(source).propose({ error, model, messages: [], applied });
  }

  it('proposes a credential refresh for recoverable errors', () => {
    const proposal = propose({ resolve: (m) => m, canRecover: () => true }, statusError(401));

    expect(proposal).toEqual({ action: 'refresh-credentials' });
  });

  it('ignores non-recoverable errors', () => {
    const proposal = propose({ resolve: (m) => m, canRecover: () => false }, statusError(401));

    expect(proposal).toBeUndefined();
  });

  it('ignores errors when the source has no canRecover', () => {
    const proposal = propose({ resolve: (m) => m }, statusError(401));

    expect(proposal).toBeUndefined();
  });

  it('does not propose again once a credential recovery was applied', () => {
    const proposal = propose({ resolve: (m) => m, canRecover: () => true }, statusError(401), [
      { strategy: 'credential', action: 'refresh-credentials' },
    ]);

    expect(proposal).toBeUndefined();
  });
});

describe('kimiOAuthCredentialSource', () => {
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

  it('resolves the model apiKey from the token provider', async () => {
    const { calls, tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    const resolved = await source.resolve({ ...model, baseUrl: 'https://example.com/v1' });

    expect(resolved).toEqual({
      ...model,
      baseUrl: 'https://example.com/v1',
      apiKey: 'access-token',
    });
    expect(calls).toEqual([false]);
  });

  it('passes force through to the token provider', async () => {
    const { calls, tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    await source.resolve(model, { force: true });

    expect(calls).toEqual([true]);
  });

  it('recovers only from 401 errors', () => {
    const { tokens } = createTokens();
    const source = kimiOAuthCredentialSource(tokens);

    expect(source.canRecover?.(model, statusError(401))).toBe(true);
    expect(source.canRecover?.(model, Object.assign(new Error('x'), { statusCode: 401 }))).toBe(
      true,
    );
    expect(source.canRecover?.(model, statusError(403))).toBe(false);
    expect(source.canRecover?.(model, new Error('boom'))).toBe(false);
    expect(source.canRecover?.(model, 'nope')).toBe(false);
  });
});

function statusErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  return typeof status === 'number' ? status : undefined;
}
