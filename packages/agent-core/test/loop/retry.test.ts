import {
  APIConnectionError,
  APIProviderRateLimitError,
  emptyUsage,
  isRetryableGenerateError,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '#/config';
import { ErrorCodes, KimiError } from '#/errors';
import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop/llm';
import { chatWithRetry, DEFAULT_MAX_RETRY_ATTEMPTS, retryBackoffDelays } from '#/loop/retry';
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
  it('preserves caller-set requestLogFields across attempts while owning turnStep/attempt', async () => {
    // The strict-resend path marks its params with `projection: 'strict'`;
    // the per-attempt rebuild must merge that marker instead of replacing
    // the whole fields object.
    let calls = 0;
    const seenFields: Array<LLMChatParams['requestLogFields']> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        seenFields.push(params.requestLogFields);
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };
    const input = makeInput(llm, new AbortController().signal);

    await chatWithRetry({
      ...input,
      params: { ...input.params, requestLogFields: { projection: 'strict' } },
    });

    expect(seenFields).toEqual([
      { projection: 'strict', turnStep: 't.1' },
      { projection: 'strict', turnStep: 't.1', attempt: '2/10' },
    ]);
  });

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

describe('retryBackoffDelays', () => {
  it('uses a 500ms base, factor-2 ramp, 32s cap, and up to +25% jitter', () => {
    const delays = retryBackoffDelays(10);
    expect(delays).toHaveLength(9);
    // Max possible delay is the capped base (32s) plus 25% jitter = 40s.
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(40_000);
    }
    // First attempt base is 500ms (plus up to 25% jitter) -> within [500, 625].
    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
  });

  it('reaches the 32s cap for high-attempt configs (overload ride-out)', () => {
    // The ramp hits 32s by attempt 7 (500 * 2^6); across many draws the peak
    // approaches the cap (32s..40s with jitter), well above the old 5s cap.
    let maxSeen = 0;
    for (let i = 0; i < 50; i += 1) {
      for (const d of retryBackoffDelays(12)) {
        maxSeen = Math.max(maxSeen, d);
      }
    }
    expect(maxSeen).toBeGreaterThan(30_000);
  });

  it('keeps low-attempt configs quick so latency-sensitive runs are not slowed', () => {
    // 3 attempts -> 2 delays at the bottom of the ramp (~0.5s / ~1s before
    // jitter); their sum stays small.
    const delays = retryBackoffDelays(3);
    expect(delays).toHaveLength(2);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThan(3_000);
  });
});

describe('chatWithRetry: default retry budget', () => {
  it('retries up to DEFAULT_MAX_RETRY_ATTEMPTS before giving up', async () => {
    // A sustained 429 carries a 1ms server retry-after so the test exercises
    // the full default budget without sleeping through the real backoff.
    let calls = 0;
    const captured: Array<{ type: string }> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIProviderRateLimitError('rate limited', null, 1);
      },
    };
    const input = makeInput(llm, new AbortController().signal);

    await expect(
      chatWithRetry({
        ...input,
        dispatchEvent: async (event) => {
          captured.push(event as { type: string });
        },
      }),
    ).rejects.toMatchObject({ name: 'APIProviderRateLimitError' });

    expect(calls).toBe(DEFAULT_MAX_RETRY_ATTEMPTS);
    expect(captured.filter((e) => e.type === 'step.retrying')).toHaveLength(
      DEFAULT_MAX_RETRY_ATTEMPTS - 1,
    );
  });
});

describe('chatWithRetry: honors server retry-after', () => {
  it('uses the error retryAfterMs as the retry delay instead of the backoff', async () => {
    let calls = 0;
    const captured: Array<{ type: string; delayMs?: number }> = [];
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (e) => isRetryableGenerateError(e),
      async chat(): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) {
          // 429 carrying a server `retry-after` of 42ms. Kept tiny so the test
          // sleeps only briefly, while still being distinguishable from the
          // attempt-1 backoff (500..625ms) it must override.
          throw new APIProviderRateLimitError('rate limited', null, 42);
        }
        return okResponse();
      },
    };
    const input = makeInput(llm, new AbortController().signal);
    await chatWithRetry({
      ...input,
      dispatchEvent: async (event) => {
        captured.push(event as { type: string; delayMs?: number });
      },
    });

    expect(calls).toBe(2);
    const retrying = captured.find((e) => e.type === 'step.retrying');
    expect(retrying?.delayMs).toBe(42);
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
