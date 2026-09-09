import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmErrorMessage } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import { kimiOAuthCredentialSource } from '#/kimi-oauth/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function statusError(status: number): LlmErrorMessage {
  return {
    kind: 'status',
    statusCode: status,
    message: `status ${status}`,
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

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
