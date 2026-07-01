import { APIConnectionError, emptyUsage } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLM, LLMChatParams, LLMChatResponse } from '#/loop';
import { chatWithRetry } from '#/loop/retry';

function okResponse(): LLMChatResponse {
  return { toolCalls: [], usage: emptyUsage() };
}

function makeInput(llm: LLM, signal: AbortSignal): Parameters<typeof chatWithRetry>[0] {
  return {
    llm,
    params: { messages: [], tools: [], signal },
    dispatchEvent: async () => { },
    turnId: 'turn-1',
    currentStep: 1,
    stepUuid: 'step-1',
  };
}

describe('chatWithRetry: terminated stream drops', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries an APIConnectionError("terminated") and succeeds on a later attempt', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (error) =>
        error instanceof APIConnectionError && error.message === 'terminated',
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        if (calls === 1) throw new APIConnectionError('terminated');
        return okResponse();
      },
    };

    const responsePromise = chatWithRetry(makeInput(llm, new AbortController().signal));
    await vi.runAllTimersAsync();

    await expect(responsePromise).resolves.toEqual(okResponse());
    expect(calls).toBe(2);
  });

  it('does NOT retry when the signal is aborted (user ESC), surfacing a clean AbortError', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const llm: LLM = {
      systemPrompt: '',
      modelName: 'mock',
      isRetryableError: (error) =>
        error instanceof APIConnectionError && error.message === 'terminated',
      async chat(_params: LLMChatParams): Promise<LLMChatResponse> {
        calls += 1;
        throw new APIConnectionError('terminated');
      },
    };

    await expect(chatWithRetry(makeInput(llm, controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
  });
});
