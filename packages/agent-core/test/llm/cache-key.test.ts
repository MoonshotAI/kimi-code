import { describe, expect, it } from 'vitest';

import { createUserMessage, type Message } from '#/llm/message';
import type { LlmModelSpec } from '#/llm/request';
import { generate, type LlmAttemptEvent } from '#/llm/generate';
import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';

const spec: LlmModelSpec = {
  provider: 'test',
  name: 'test-model',
};
const control = () => ({ signal: new AbortController().signal });
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

function streamedParts(events: readonly LlmAttemptEvent[]): unknown[] {
  return events.flatMap((event) => (event.type === 'llm.streaming.part' ? [event.part] : []));
}

function stubOpenAIClient(data: unknown): {
  clientFactory: () => unknown;
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
                  data,
                  response: new Response(null),
                }),
              };
            },
          },
        },
      }),
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

function stubAnthropicClient(data: unknown): {
  clientFactory: () => unknown;
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
                data,
                response: new Response(null),
              }),
            };
          },
        },
      }),
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

describe('openai requester cacheKey', () => {
  it('encodes the cache key as prompt_cache_key in stream and non-stream modes', async () => {
    const client = stubOpenAIClient(createAsyncStream(chatCompletionChunks));
    await generate(
      {
        protocol: { base: openAIProtocol, options: { extras: { extra_body: { trace_id: 't1' } } } },
        endpoint: { clientFactory: client.clientFactory },
        model: { spec, cacheKey: 'session-1', sampling: { stop: ['END'], presencePenalty: 0.5 } },
        content: { messages },
      },
      control(),
    );
    expect(client.body()['prompt_cache_key']).toBe('session-1');
    expect(client.body()['stop']).toEqual(['END']);
    expect(client.body()['presence_penalty']).toBe(0.5);
    expect(client.body()['trace_id']).toBe('t1');
    expect(client.body()['extra_body']).toBeUndefined();
    expect(client.body()['stream']).toBe(true);
    expect(client.body()['stream_options']).toEqual({ include_usage: true });

    const once = stubOpenAIClient({
      id: 'chatcmpl-2',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hi',
            reasoning_content: 'why',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'f', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const events: LlmAttemptEvent[] = [];
    await generate(
      {
        protocol: { base: openAIProtocol, stream: false },
        endpoint: { clientFactory: once.clientFactory },
        model: { spec, cacheKey: 'session-1' },
        content: { messages },
      },
      { ...control(), onEvent: (event) => events.push(event) },
    );
    expect(once.body()['prompt_cache_key']).toBe('session-1');
    expect(once.body()['stream']).toBe(false);
    expect(once.body()['stream_options']).toBeUndefined();
    expect(streamedParts(events)).toEqual([
      { type: 'think', think: 'why', reasoningKey: 'reasoning_content' },
      { type: 'text', text: 'hi' },
      { type: 'function', id: 'call-1', name: 'f', arguments: '{}' },
    ]);
    expect(events).toContainEqual({
      type: 'llm.streaming.finish',
      finish: { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' },
    });
    expect(events.some((event) => event.type === 'attempt.failed')).toBe(false);
  });

  it('derives a protocol that replaces only the cache key slot and omits it without a cache key', async () => {
    const client = stubOpenAIClient(createAsyncStream(chatCompletionChunks));
    const derived = openAIProtocol.with({ cacheKey: (key) => ({ custom_cache: key }) });
    await generate(
      {
        protocol: { base: derived },
        endpoint: { clientFactory: client.clientFactory },
        model: { spec, cacheKey: 'session-1', sampling: { topP: 0.5 } },
        content: { messages },
      },
      control(),
    );
    expect(client.body()['custom_cache']).toBe('session-1');
    expect(client.body()['prompt_cache_key']).toBeUndefined();
    expect(client.body()['top_p']).toBe(0.5);
    expect(openAIProtocol.cacheKey?.('k')).toEqual({
      prompt_cache_key: 'k',
    });

    const plain = stubOpenAIClient(createAsyncStream(chatCompletionChunks));
    await generate(
      {
        protocol: { base: openAIProtocol },
        endpoint: { clientFactory: plain.clientFactory },
        model: { spec },
        content: { messages },
      },
      control(),
    );
    expect(plain.body()['prompt_cache_key']).toBeUndefined();
  });
});

describe('anthropic requester cacheKey', () => {
  it('encodes the cache key as metadata.user_id in stream and non-stream modes', async () => {
    const client = stubAnthropicClient(createAsyncStream(anthropicStreamEvents));
    await generate(
      {
        protocol: { base: anthropicProtocol },
        endpoint: { clientFactory: client.clientFactory },
        model: { spec, cacheKey: 'session-1', sampling: { topK: 5 } },
        content: { messages },
      },
      control(),
    );
    expect(client.body()['metadata']).toEqual({ user_id: 'session-1' });
    expect(client.body()['top_k']).toBe(5);
    expect(client.body()['stream']).toBe(true);

    const once = stubAnthropicClient({
      id: 'msg-1',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [
        { type: 'thinking', thinking: 'why', signature: 'sig' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'tool-1', name: 'f', input: { a: 1 } },
      ],
    });
    const events: LlmAttemptEvent[] = [];
    await generate(
      {
        protocol: { base: anthropicProtocol, stream: false },
        endpoint: { clientFactory: once.clientFactory },
        model: { spec, cacheKey: 'session-1' },
        content: { messages },
      },
      { ...control(), onEvent: (event) => events.push(event) },
    );
    expect(once.body()['metadata']).toEqual({ user_id: 'session-1' });
    expect(once.body()['stream']).toBe(false);
    expect(streamedParts(events)).toEqual([
      { type: 'think', think: 'why', encrypted: 'sig' },
      { type: 'text', text: 'hi' },
      { type: 'function', id: 'tool-1', name: 'f', arguments: '{"a":1}' },
    ]);
    expect(events).toContainEqual({ type: 'llm.streaming.message_id', messageId: 'msg-1' });
    expect(events.some((event) => event.type === 'attempt.failed')).toBe(false);
  });
});
