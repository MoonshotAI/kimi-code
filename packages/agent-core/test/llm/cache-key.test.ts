import { describe, expect, it } from 'vitest';

import { createUserMessage, type Message } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import { bindAnthropic } from '#/llm/builtin/protocol/anthropic/index';
import { bindOpenAI } from '#/llm/builtin/protocol/openai/index';
import { createRequesterFromHandle } from '#/llm/protocol/runner';
import type { LlmClientContext } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

const chatCompletionChunks: readonly Record<string, unknown>[] = [
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  },
];

const anthropicStreamEvents: readonly Record<string, unknown>[] = [
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured.push(params);
              return {
                withResponse: async () => ({
                  data: createAsyncStream(chunks),
                  response: new Response(null),
                }),
              };
            },
          },
        },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

function stubAnthropicClient(events: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () =>
      ({
        messages: {
          create: (params: Record<string, unknown>) => {
            captured.push(params);
            return {
              withResponse: async () => ({
                data: createAsyncStream(events),
                response: new Response(null),
              }),
            };
          },
        },
      }) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

describe('openai requester cacheKey', () => {
  it('encodes the cache key as prompt_cache_key by default', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createRequesterFromHandle(bindOpenAI({
      clientFactory: client.clientFactory,
      extras: { extra_body: { trace_id: 't1' } },
    }));
    await requester.generate(
      {
        model,
        cacheKey: 'session-1',
        sampling: { stop: ['END'], presencePenalty: 0.5 },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['prompt_cache_key']).toBe('session-1');
    expect(client.body()['stop']).toEqual(['END']);
    expect(client.body()['presence_penalty']).toBe(0.5);
    expect(client.body()['extra_body']).toEqual({ trace_id: 't1' });
  });

  it('lets a trait override the cache key params', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createRequesterFromHandle(bindOpenAI({
      trait: { encodeCacheKey: (key) => ({ custom_cache: key }) },
      clientFactory: client.clientFactory,
    }));
    await requester.generate(
      { model, cacheKey: 'session-1' },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['custom_cache']).toBe('session-1');
    expect(client.body()['prompt_cache_key']).toBeUndefined();
  });

  it('omits prompt_cache_key when no cache key is given', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createRequesterFromHandle(bindOpenAI({ clientFactory: client.clientFactory }));
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['prompt_cache_key']).toBeUndefined();
  });
});

describe('anthropic requester cacheKey', () => {
  it('encodes the cache key as metadata.user_id', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createRequesterFromHandle(bindAnthropic({ clientFactory: client.clientFactory }));
    await requester.generate(
      { model, cacheKey: 'session-1', sampling: { topK: 5 } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['metadata']).toEqual({ user_id: 'session-1' });
    expect(client.body()['top_k']).toBe(5);
  });
});
