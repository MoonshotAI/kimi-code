import { APIConnectionError, emptyUsage, isRetryableGenerateError } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '#/config';
import { ErrorCodes, KimiError } from '#/errors';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { chatWithRetry } from '#/loop/retry';
import { ProviderManager } from '#/session/provider-manager';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(
  llm: LLM,
  signal: AbortSignal,
): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent: async () => {},
    turnId: 't',
    currentStep: 1,
    stepUuid: 'u',
  };
}

describe('chatWithRetry: terminated stream drops', () => {
  it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
    // A mid-stream `terminated` is classified as a retryable APIConnectionError,
    // so an intermittent connection drop should be recovered transparently.
    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };

    const response = await chatWithRetry(makeInput(llm, new AbortController().signal));

    expect(calls).toBe(2);
    expect(response).toEqual(okResponse());
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    // Even though `terminated` is retryable, a user-aborted request must never
    // be retried: the abort signal is checked before any retry, so it surfaces
    // as an AbortError rather than a provider error.
    let calls = 0;
    const ac = new AbortController();
    ac.abort();

    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });

  it('does not retry OAuth token fetch connection errors (already retried internally)', async () => {
    let tokenCalls = 0;
    const manager = new ProviderManager({
      config: oauthConfig(),
      resolveOAuthTokenProvider: () => ({
        async getAccessToken() {
          tokenCalls += 1;
          throw new KimiError(
            ErrorCodes.PROVIDER_CONNECTION_ERROR,
            'OAuth provider "managed:kimi-code" failed to fetch an access token: fetch failed',
          );
        },
      }),
    });
    const resolveAuth = manager.resolveAuth('kimi-code/kimi-for-coding');
    if (resolveAuth === undefined) throw new Error('expected OAuth auth resolver');

    let chatCalls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        chatCalls += 1;
        return resolveAuth(async () => okResponse());
      },
    };

    await expect(chatWithRetry(makeInput(llm, new AbortController().signal))).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
    });
    expect(chatCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });
});

function oauthConfig(): KimiConfig {
  return {
    defaultModel: 'kimi-code/kimi-for-coding',
    providers: {
      'managed:kimi-code': {
        type: 'kimi',
        apiKey: '',
        baseUrl: 'https://api.example/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
    },
    models: {
      'kimi-code/kimi-for-coding': {
        provider: 'managed:kimi-code',
        model: 'kimi-for-coding',
        maxContextSize: 1_000_000,
      },
    },
  };
}
