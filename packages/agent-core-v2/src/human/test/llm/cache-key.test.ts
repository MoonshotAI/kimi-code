import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createToolMessage, createUserMessage, type Message, type ToolDescription } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmClientContext, LlmRequester } from '#/llm/requester/requester';
import { kimiOpenAITrait } from '#/llm-kimi/trait';

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
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      {
        model,
        cacheKey: 'session-1',
        extraParams: { openai: { stop: ['END'], presence_penalty: 0.5, extra_body: { trace_id: 't1' } } },
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
    const requester = createOpenAIRequester({
      trait: { encodeCacheKey: (key) => ({ custom_cache: key }) },
      clientFactory: client.clientFactory,
    });
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
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
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
    const requester = createAnthropicRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model, cacheKey: 'session-1', extraParams: { anthropic: { top_k: 5 } } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['metadata']).toEqual({ user_id: 'session-1' });
    expect(client.body()['top_k']).toBe(5);
  });
});

describe('serialized prompt-cache prefix', () => {
  const conversation: readonly Message[] = [
    createUserMessage('inspect the repository'),
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'planning the inspection' },
        { type: 'text', text: 'I will list the files.' },
      ],
      toolCalls: [{ type: 'function', id: 'call_1', name: 'ListFiles', arguments: '{"path":"."}' }],
    },
    createToolMessage('call_1', 'README.md\nsrc/'),
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The repository has a README and a src directory.' }],
      toolCalls: [],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this screenshot' },
        { type: 'image_url', imageUrl: { url: 'https://example.test/screen.png' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'reading the screenshot' },
        { type: 'text', text: 'It shows a failing build.' },
      ],
      toolCalls: [],
    },
    createUserMessage('fix the build'),
  ];
  const requestEnds = [1, 3, 5, 7] as const;
  const tools: readonly ToolDescription[] = [
    {
      name: 'ListFiles',
      description: 'List files under a path.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ];

  function withoutCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCacheControl);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, entry]) => [key, withoutCacheControl(entry)]),
    );
  }

  it.each([
    {
      protocol: 'openai',
      firstReasoningHistoryParams: { reasoning_effort: 'medium' },
      create: () => {
        const client = stubOpenAIClient(chatCompletionChunks);
        return { client, requester: createOpenAIRequester({ clientFactory: client.clientFactory }) };
      },
    },
    {
      protocol: 'kimi',
      firstReasoningHistoryParams: {},
      create: () => {
        const client = stubOpenAIClient(chatCompletionChunks);
        return {
          client,
          requester: createOpenAIRequester({
            trait: kimiOpenAITrait,
            clientFactory: client.clientFactory,
          }),
        };
      },
    },
    {
      protocol: 'anthropic',
      firstReasoningHistoryParams: {},
      create: () => {
        const client = stubAnthropicClient(anthropicStreamEvents);
        return { client, requester: createAnthropicRequester({ clientFactory: client.clientFactory }) };
      },
    },
  ] satisfies readonly {
    readonly protocol: string;
    readonly firstReasoningHistoryParams: Record<string, unknown>;
    readonly create: () => {
      readonly client: { readonly body: () => Record<string, unknown> };
      readonly requester: LlmRequester;
    };
  }[])(
    'serializes each $protocol request as a prefix extension of the previous request',
    async ({ create, firstReasoningHistoryParams }) => {
      const { client, requester } = create();
      const bodies: Record<string, unknown>[] = [];
      for (const end of requestEnds) {
        await requester.generate(
          { model, systemPrompt: 'You are a coding agent.', tools: [...tools], cacheKey: 'session-1' },
          { messages: conversation.slice(0, end) },
          { signal: new AbortController().signal },
        );
        bodies.push(withoutCacheControl(client.body()) as Record<string, unknown>);
      }

      for (const [index, body] of bodies.entries()) {
        if (index === 0) continue;
        const { messages: previousMessages, ...previousRest } = bodies[index - 1]!;
        const { messages: nextMessages, ...nextRest } = body;
        expect(nextRest).toEqual(
          index === 1 ? { ...previousRest, ...firstReasoningHistoryParams } : previousRest,
        );
        const previousList = previousMessages as readonly unknown[];
        expect(previousList.length).toBeGreaterThan(0);
        expect((nextMessages as readonly unknown[]).slice(0, previousList.length)).toEqual(previousList);
      }
    },
  );
});
