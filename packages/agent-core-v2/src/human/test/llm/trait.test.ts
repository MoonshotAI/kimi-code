import { afterEach, describe, expect, it, vi } from 'vitest';

import { isUnknownCapability, UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import type { FinishInfo } from '#/llm/finish-reason';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isToolCall,
  type Message,
  type StreamedMessagePart,
  type ToolDescription,
  type VideoURLPart,
} from '#/llm/message';
import { createMemoryMediaUploadCache } from '#/llm/media/cache';
import { createMediaRefResolver } from '#/llm/media/resolver';
import { createMemoryMediaSource } from '#/llm/media/source';
import type { LlmModel } from '#/llm/model';
import { createProvider } from '#/llm/provider/definition';
import { KimiFiles } from '#/llm-kimi/files';
import { kimiMediaContribution } from '#/llm-kimi/media';
import { kimiProvider } from '#/llm-kimi/provider';
import {
  KIMI_API_KEY_ENV,
  KIMI_BASE_URL_ENV,
  KIMI_DEFAULT_BASE_URL,
  kimiAnthropicTrait,
  kimiOpenAITrait,
} from '#/llm-kimi/trait';
import { anthropicProvider, openaiProvider } from '#/llm/provider/providers/standard';
import type { LlmClientContext, LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
} from '#/llm/requester/bases/tool-call-id';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { createOpenAIResponsesRequester } from '#/llm/requester/bases/openai-responses/requester';
import {
  createOpenAIRequester,
  openAIBase,
} from '#/llm/requester/bases/openai/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  baseUrl: 'https://example.test/v1',
  capability: UNKNOWN_CAPABILITY,
};
const messages: readonly Message[] = [createUserMessage('hi')];

async function generateAndCollectUsage(
  requester: LlmRequester,
): Promise<TokenUsage | undefined> {
  let usage: TokenUsage | undefined;
  await requester.generate(
    { model },
    { messages },
    {
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === 'llm.usage') {
          usage = event.usage;
        }
      },
    },
  );
  return usage;
}

const TRAIT_CAPABILITY: ModelCapability = {
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
};

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
  { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 1 } } },
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

function withResponseStream(chunks: readonly Record<string, unknown>[]): {
  withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>>; response: Response }>;
} {
  return {
    withResponse: async () => ({
      data: createAsyncStream(chunks),
      response: new Response(null),
    }),
  };
}

interface CapturedClientCall {
  params: Record<string, unknown>;
  headers?: Record<string, string>;
  options?: { headers?: Record<string, string> };
  beta?: boolean;
}

interface ClientStub {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
  headers: () => Record<string, string> | undefined;
  requestHeaders: () => Record<string, string> | undefined;
  called: () => boolean;
  betaCalled: () => boolean;
}

function createClientStub(
  build: (captured: CapturedClientCall[], request: LlmClientContext) => unknown,
): ClientStub {
  const captured: CapturedClientCall[] = [];
  return {
    clientFactory: (request) => build(captured, request) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last.params;
    },
    headers: () => captured.at(-1)?.headers,
    requestHeaders: () => captured.at(-1)?.options?.headers,
    called: () => captured.length > 0,
    betaCalled: () => captured.at(-1)?.beta === true,
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured, request) => ({
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => {
          captured.push({ params, headers: request.headers });
          return withResponseStream(chunks);
        },
      },
    },
  }));
}

function stubResponsesClient(events: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured, request) => ({
    responses: {
      create: (params: Record<string, unknown>) => {
        captured.push({ params, headers: request.headers });
        return withResponseStream(events);
      },
    },
  }));
}

function stubAnthropicClient(events: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured, request) => ({
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: { headers?: Record<string, string> },
      ) => {
        captured.push({ params, headers: request.headers, options });
        return withResponseStream(events);
      },
    },
    beta: {
      messages: {
        create: (
          params: Record<string, unknown>,
          options?: { headers?: Record<string, string> },
        ) => {
          captured.push({ params, headers: request.headers, options, beta: true });
          return withResponseStream(events);
        },
      },
    },
  }));
}

function stubGoogleClient(chunks: readonly Record<string, unknown>[]): ClientStub {
  return createClientStub((captured, request) => ({
    models: {
      generateContentStream: async (params: Record<string, unknown>) => {
        captured.push({ params, headers: request.headers });
        return createAsyncStream(chunks);
      },
    },
  }));
}

describe('defaultHeaders', () => {
  it('sends trait-declared headers on openai requests', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(
      { defaultHeaders: () => ({ 'x-trait': 'a' }) },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.headers()?.['x-trait']).toBe('a');
  });

  it('sends model defaultHeaders on openai requests', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model: { ...model, defaultHeaders: { 'x-model': 'b' } } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.headers()?.['x-model']).toBe('b');
  });

  it('lets model headers override trait headers', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(
      { defaultHeaders: () => ({ 'x-k': 'trait' }) },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      { model: { ...model, defaultHeaders: { 'x-k': 'model' } } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.headers()?.['x-k']).toBe('model');
  });

  it('sends merged headers on anthropic requests', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(
      { defaultHeaders: () => ({ 'x-trait': 'a' }) },
      { clientFactory: client.clientFactory },
    );
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    await requester.generate(
      { model: { ...model, defaultHeaders: { 'x-model': 'b' } } },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.finish') finish = event.finish;
          if (event.type === 'llm.message-id') messageId = event.messageId;
        },
      },
    );
    expect(client.headers()?.['x-trait']).toBe('a');
    expect(client.headers()?.['x-model']).toBe('b');
    expect(finish).toEqual({ finishReason: 'completed', rawFinishReason: 'end_turn' });
    expect(messageId).toBe('msg_1');
  });
});

describe('capability', () => {
  it('resolves capabilities from the base prefixes and the trait hook', () => {
    const reasoning = openaiProvider.resolveModel('o1').capability;
    expect(reasoning.thinking).toBe(true);
    expect(reasoning.tool_use).toBe(true);
    expect(reasoning.image_in).toBe(false);
    const vision = openaiProvider.resolveModel('gpt-4o').capability;
    expect(vision.image_in).toBe(true);
    expect(vision.thinking).toBe(false);
    const textOnly = openaiProvider.resolveModel('gpt-3.5-turbo').capability;
    expect(textOnly.tool_use).toBe(true);
    expect(textOnly.image_in).toBe(false);
    expect(textOnly.thinking).toBe(false);
    expect(isUnknownCapability(openaiProvider.resolveModel('no-such-model').capability)).toBe(
      true,
    );

    const thinkingVision = anthropicProvider.resolveModel('claude-sonnet-4-20250514').capability;
    expect(thinkingVision.thinking).toBe(true);
    expect(thinkingVision.image_in).toBe(true);
    const legacyVision = anthropicProvider.resolveModel('claude-3-haiku').capability;
    expect(legacyVision.image_in).toBe(true);
    expect(legacyVision.thinking).toBe(false);
    expect(
      isUnknownCapability(anthropicProvider.resolveModel('no-such-model').capability),
    ).toBe(true);

    const traitCapProvider = createProvider({
      id: 'test-trait-cap',
      protocols: { openai: { base: openAIBase, trait: { capability: () => TRAIT_CAPABILITY } } },
    });
    expect(traitCapProvider.resolveModel('o1').capability).toBe(TRAIT_CAPABILITY);
  });

  it('enriches listModels seeds and returns an empty list without a model source', async () => {
    await expect(openaiProvider.listModels()).resolves.toEqual([]);

    const provider = createProvider({
      id: 'test-list',
      protocols: { openai: { base: openAIBase } },
      models: async () => [
        { model: 'gpt-4o' },
        { model: 'seed-cap', capability: TRAIT_CAPABILITY, baseUrl: 'https://seed.test/v1' },
        { model: 'unknown-x' },
      ],
    });
    const listed = await provider.listModels();
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({
      provider: 'test-list',
      model: 'gpt-4o',
      capability: { image_in: true, thinking: false },
    });
    expect(listed[1]).toMatchObject({
      model: 'seed-cap',
      capability: TRAIT_CAPABILITY,
      baseUrl: 'https://seed.test/v1',
    });
    expect(isUnknownCapability((listed[2] as LlmModel).capability)).toBe(true);
  });
});

describe('media', () => {
  const mediaModel: LlmModel = {
    provider: 'test-media',
    model: 'test-model',
    capability: TRAIT_CAPABILITY,
  };
  const uploadedPart: VideoURLPart = {
    type: 'video_url',
    videoUrl: { url: 'ms://file-1', id: 'file-1' },
  };

  function videoRefMessage(url: string): Message {
    return { role: 'user', content: [{ type: 'video_url', videoUrl: { url } }] };
  }

  it('rejects a non-video mime type', async () => {
    await expect(
      kimiMediaContribution.uploadVideo!(
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { model },
      ),
    ).rejects.toThrow('Expected a video mime type');
  });

  it('requires an api key', async () => {
    const files = new KimiFiles({ baseUrl: 'https://example.test/v1' });
    await expect(
      files.uploadVideo({ data: new Uint8Array([1]), mimeType: 'video/mp4' }),
    ).rejects.toThrow('apiKey is required');
  });

  it('uploads a video ref once and serves later requests from the cache', async () => {
    const uploadVideo = vi.fn(async () => uploadedPart);
    const provider = createProvider({
      id: 'test-media',
      protocols: { openai: { base: openAIBase } },
      media: { uploadVideo },
    });
    const resolver = createMediaRefResolver({
      providers: [provider],
      source: createMemoryMediaSource({
        'ref-1': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' },
      }),
      cache: createMemoryMediaUploadCache(),
    });
    const messages = [videoRefMessage('media://ref-1')];
    const ctx = { model: mediaModel, signal: new AbortController().signal };

    const first = await resolver.resolve(messages, ctx);
    const second = await resolver.resolve(messages, ctx);

    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(first[0]?.content).toEqual([uploadedPart]);
    expect(second[0]?.content).toEqual([uploadedPart]);
  });

  it('degrades to a text part when the media source has no bytes', async () => {
    const provider = createProvider({
      id: 'test-media',
      protocols: { openai: { base: openAIBase } },
      media: { uploadVideo: vi.fn() },
    });
    const resolver = createMediaRefResolver({
      providers: [provider],
      source: createMemoryMediaSource(),
      cache: createMemoryMediaUploadCache(),
    });
    const resolved = await resolver.resolve([videoRefMessage('media://missing')], {
      model: mediaModel,
      signal: new AbortController().signal,
    });
    expect(resolved[0]?.content).toEqual([
      { type: 'text', text: '[video omitted: media unavailable]' },
    ]);
  });

  it('inlines video bytes when the provider declares inline video and no uploader exists', async () => {
    const provider = createProvider({
      id: 'test-media',
      protocols: { openai: { base: openAIBase } },
      media: { inlineVideo: true },
    });
    const resolver = createMediaRefResolver({
      providers: [provider],
      source: createMemoryMediaSource({
        'ref-1': { bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' },
      }),
      cache: createMemoryMediaUploadCache(),
    });
    const resolved = await resolver.resolve([videoRefMessage('media://ref-1')], {
      model: mediaModel,
      signal: new AbortController().signal,
    });
    expect(resolved[0]?.content).toEqual([
      {
        type: 'video_url',
        videoUrl: { url: `data:video/mp4;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
      },
    ]);
  });
});


describe('endpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('injects the endpoint from env and trait defaults at request time', async () => {
    vi.stubEnv(KIMI_BASE_URL_ENV, '');
    vi.stubEnv(KIMI_API_KEY_ENV, 'env-key');
    const seen: LlmModel[] = [];
    const client = createClientStub((captured, request) => {
      seen.push(request.model);
      return {
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured.push({ params, headers: request.headers });
              return withResponseStream(chatCompletionChunks);
            },
          },
        },
      };
    });
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    const signal = new AbortController().signal;

    await requester.generate(
      { model: kimiProvider.resolveModel('kimi-k3') },
      { messages },
      { signal },
    );
    vi.stubEnv(KIMI_BASE_URL_ENV, 'https://example.test/v9');
    await requester.generate(
      { model: kimiProvider.resolveModel('kimi-k3') },
      { messages },
      { signal },
    );
    await requester.generate(
      { model: kimiProvider.resolveModel('kimi-k3', { baseUrl: 'https://explicit.test/v1' }) },
      { messages },
      { signal },
    );

    expect(seen.map((entry) => entry.baseUrl)).toEqual([
      KIMI_DEFAULT_BASE_URL,
      'https://example.test/v9',
      'https://explicit.test/v1',
    ]);
    expect(seen[0]?.apiKey).toBe('env-key');
  });

  it('selects protocols by name and rejects undeclared ones', () => {
    expect(kimiProvider.protocols).toEqual(['openai', 'anthropic_beta', 'openai_responses']);
    expect(() => kimiProvider.createRequester('google-genai')).toThrow(
      "provider 'kimi' has no protocol 'google-genai'",
    );
    expect(() => kimiProvider.resolveModel('kimi-k3', { protocol: 'google-genai' })).toThrow(
      "provider 'kimi' has no protocol 'google-genai'",
    );

    const requester: LlmRequester = { generate: () => Promise.resolve() };
    const passthrough = createProvider({
      id: 'test-passthrough',
      protocols: { openai: { base: { createRequester: () => requester } } },
    });
    expect(passthrough.createRequester()).toBe(requester);
    expect(passthrough.createRequester('openai')).toBe(requester);

    const resolved = kimiProvider.resolveModel('kimi-k3', {
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      defaultHeaders: { 'x-h': 'v' },
    });
    expect(resolved).toEqual({
      provider: 'kimi',
      model: 'kimi-k3',
      capability: resolved.capability,
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      defaultHeaders: { 'x-h': 'v' },
    });
    expect(isUnknownCapability(resolved.capability)).toBe(true);
  });
});

describe('convertTool', () => {
  const tools: readonly ToolDescription[] = [
    { name: '$web_search', description: 'search the web', parameters: { type: 'object' } },
    {
      name: 'get_weather',
      description: 'get weather',
      parameters: { type: 'object', properties: { unit: { enum: ['c', 'f'] } } },
    },
  ];

  it('maps $-prefixed tools to builtin_function', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model, tools },
      { messages },
      { signal: new AbortController().signal },
    );
    const bodyTools = client.body()['tools'] as Record<string, unknown>[];
    expect(bodyTools[0]).toEqual({
      type: 'builtin_function',
      function: { name: '$web_search' },
    });
  });

  it('normalizes tool schemas for kimi', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model, tools },
      { messages },
      { signal: new AbortController().signal },
    );
    const bodyTools = client.body()['tools'] as Record<string, unknown>[];
    const weather = bodyTools[1] as { function: { parameters: Record<string, unknown> } };
    const properties = weather.function.parameters['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties['unit']?.['type']).toBe('string');
  });

  it('uses the default tool mapping without a trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model, tools: [tools[1]!] },
      { messages },
      { signal: new AbortController().signal },
    );
    const bodyTools = client.body()['tools'] as Record<string, unknown>[];
    const weather = bodyTools[0] as { function: { parameters: Record<string, unknown> } };
    const properties = weather.function.parameters['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties['unit']?.['type']).toBeUndefined();
  });
});

describe('message-level tools', () => {
  const declared: readonly ToolDescription[] = [
    { name: 'get_weather', description: 'get weather', parameters: { type: 'object' } },
  ];

  it('serializes system message tools for kimi', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model },
      { messages: [{ role: 'system', content: [], tools: [...declared] }, ...messages] },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    expect(bodyMessages[0]?.['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object' } },
      },
    ]);
  });

  it('drops system message tools without a trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      { messages: [{ role: 'system', content: [], tools: [...declared] }, ...messages] },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    expect(bodyMessages[0]?.['tools']).toBeUndefined();
  });
});

describe('withMaxCompletionTokens', () => {
  it('encodes max completion tokens via the kimi trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model, maxCompletionTokens: 1000 },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_completion_tokens']).toBe(1000);
    expect(client.body()['max_tokens']).toBeUndefined();
  });

  it('uses max_completion_tokens for reasoning models without a trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model: { ...model, model: 'gpt-5.1' }, maxCompletionTokens: 1000 },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_completion_tokens']).toBe(1000);
    expect(client.body()['max_tokens']).toBeUndefined();
  });

  it('uses max_tokens for other models without a trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model: { ...model, model: 'gpt-4o' }, maxCompletionTokens: 1000 },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(1000);
    expect(client.body()['max_completion_tokens']).toBeUndefined();
  });

  it('caps by the remaining context budget', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model: { ...model, model: 'gpt-4o' }, maxCompletionTokens: 1000, maxContextTokens: 500 },
      { messages, usedContextTokens: 200 },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(300);
  });

  it('passes max_tokens on the anthropic request path', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model, maxCompletionTokens: 1000, maxContextTokens: 500 },
      { messages, usedContextTokens: 200 },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(300);
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(128000);

    const sonnet35 = { ...model, model: 'claude-3-5-sonnet-20241022' };
    await requester.generate(
      { model: sonnet35 },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(8192);
    await requester.generate(
      { model: sonnet35, maxCompletionTokens: 128000 },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(8192);
    await requester.generate(
      { model: { ...model, model: 'claude-sonnet-4-2' } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['max_tokens']).toBe(64000);
  });
});

describe('buildParams', () => {
  it('lets the trait reshape the final params', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(
      {
        buildParams: (params) => ({ ...params, x_custom: 1 }),
      },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['x_custom']).toBe(1);
  });
});

describe('extractUsage', () => {
  it('reads usage from choices when the top level is absent', async () => {
    const client = stubOpenAIClient([
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: { content: 'hi' },
            finish_reason: 'stop',
            usage: { prompt_tokens: 3, completion_tokens: 5 },
          },
        ],
      },
    ]);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    const usage = await generateAndCollectUsage(requester);
    expect(usage?.output).toBe(5);
    expect(usage?.inputOther).toBe(3);
  });

  it('reads usage from stream choice chunks', async () => {
    const client = stubOpenAIClient([
      { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 4, completion_tokens: 6 } }] },
    ]);
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: client.clientFactory,
    });
    const usage = await generateAndCollectUsage(requester);
    expect(usage?.output).toBe(6);
    expect(usage?.inputOther).toBe(4);
  });

  it('parses top-level usage without a trait', async () => {
    const client = stubOpenAIClient([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    let usage: TokenUsage | undefined;
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    await requester.generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.usage') usage = event.usage;
          if (event.type === 'llm.finish') finish = event.finish;
          if (event.type === 'llm.message-id') messageId = event.messageId;
        },
      },
    );
    expect(usage?.output).toBe(1);
    expect(finish).toEqual({ finishReason: 'completed', rawFinishReason: 'stop' });
    expect(messageId).toBe('chatcmpl-1');
  });
});


describe('toolCallIdPolicy', () => {
  it('sanitizes unsafe characters and truncates', () => {
    expect(sanitizeToolCallId('call|abc def/ghi')).toBe('call_abc_def_ghi');
    expect(sanitizeToolCallId('a'.repeat(100), 64)).toHaveLength(64);
  });

  it('rewrites both sides of a tool call consistently', () => {
    const history = [
      createUserMessage('hi'),
      createAssistantMessage(
        [{ type: 'text', text: '' }],
        [{ type: 'function', id: 'call|abc', name: 'get_weather', arguments: '{}' }],
      ),
      createToolMessage('call|abc', 'sunny'),
    ];
    const normalized = normalizeToolCallIdsForProvider(history, {
      normalize: (id) => sanitizeToolCallId(id, 64),
      maxLength: 64,
    });
    const assistant = normalized[1]!;
    if (assistant.role !== 'assistant') throw new Error('expected assistant message');
    const tool = normalized[2]!;
    if (tool.role !== 'tool') throw new Error('expected tool message');
    expect(assistant.toolCalls[0]?.id).toBe('call_abc');
    expect(tool.toolCallId).toBe('call_abc');
  });

  it('dedupes collisions and replaces empty ids', () => {
    const colliding = normalizeToolCallIdsForProvider(
      [
        createAssistantMessage(
          [{ type: 'text', text: '' }],
          [
            { type: 'function', id: 'a b', name: 'f', arguments: null },
            { type: 'function', id: 'a/b', name: 'g', arguments: null },
          ],
        ),
      ],
      {
        normalize: (id) => sanitizeToolCallId(id, 64),
        maxLength: 64,
      },
    );
    const collidingAssistant = colliding[0]!;
    if (collidingAssistant.role !== 'assistant') throw new Error('expected assistant message');
    expect(collidingAssistant.toolCalls.map((toolCall) => toolCall.id)).toEqual(['a_b', 'a_b_2']);

    const empty = normalizeToolCallIdsForProvider(
      [
        createAssistantMessage(
          [{ type: 'text', text: '' }],
          [{ type: 'function', id: '', name: 'f', arguments: null }],
        ),
      ],
      {
        normalize: (id) => sanitizeToolCallId(id, 64),
        maxLength: 64,
      },
    );
    const emptyAssistant = empty[0]!;
    if (emptyAssistant.role !== 'assistant') throw new Error('expected assistant message');
    expect(emptyAssistant.toolCalls[0]?.id).toBe('tool_call');
  });

  it('keeps safe ids unchanged', () => {
    const history = [
      createAssistantMessage(
        [{ type: 'text', text: '' }],
        [{ type: 'function', id: 'call_1', name: 'f', arguments: null }],
      ),
    ];
    const normalized = normalizeToolCallIdsForProvider(history, {
      normalize: (id) => sanitizeToolCallId(id, 64),
      maxLength: 64,
    });
    const assistant = normalized[0]!;
    if (assistant.role !== 'assistant') throw new Error('expected assistant message');
    expect(assistant.toolCalls[0]?.id).toBe('call_1');
  });

  it('sanitizes tool call ids on the openai request path', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage(
            [{ type: 'text', text: '' }],
            [{ type: 'function', id: 'call|abc', name: 'get_weather', arguments: '{}' }],
          ),
          createToolMessage('call|abc', 'sunny'),
        ],
      },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    const toolCalls = bodyMessages[1]?.['tool_calls'] as Record<string, unknown>[];
    expect(toolCalls[0]?.['id']).toBe('call_abc');
    expect(bodyMessages[2]?.['tool_call_id']).toBe('call_abc');
  });

  it('lets the trait override the policy', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(
      {
        toolCallIdPolicy: () => ({
          normalize: (id) => sanitizeToolCallId(id, 4),
          maxLength: 4,
        }),
      },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      { model },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage(
            [{ type: 'text', text: '' }],
            [{ type: 'function', id: 'call_abcdef', name: 'f', arguments: null }],
          ),
        ],
      },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    const toolCalls = bodyMessages[1]?.['tool_calls'] as Record<string, unknown>[];
    expect(toolCalls[0]?.['id']).toBe('call');
  });

  it('sanitizes tool call ids on the anthropic request path', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage(
            [{ type: 'text', text: '' }],
            [{ type: 'function', id: 'call|abc', name: 'get_weather', arguments: '{}' }],
          ),
          createToolMessage('call|abc', 'sunny'),
        ],
      },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    const blocks = bodyMessages.flatMap(
      (message) => message['content'] as Record<string, unknown>[],
    );
    const toolUse = blocks.find((block) => block['type'] === 'tool_use');
    const toolResult = blocks.find((block) => block['type'] === 'tool_result');
    expect(toolUse?.['id']).toBe('call_abc');
    expect(toolResult?.['tool_use_id']).toBe('call_abc');
  });
});


describe('mergeHistory', () => {
  it('lets the trait merge the converted history', async () => {
    const client = stubOpenAIClient(chatCompletionChunks);
    const requester = createOpenAIRequester(
      {
        mergeHistory: (history) => [...history, { role: 'user', content: 'extra' }],
      },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    const bodyMessages = client.body()['messages'] as Record<string, unknown>[];
    expect(bodyMessages.at(-1)).toEqual({ role: 'user', content: 'extra' });
  });
});

describe('anthropic trait dialect', () => {
  it('lets the trait reshape messages, history, and tools', async () => {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(
      {
        convertMessage: (message, converted) => {
          if (extractText(message) === 'drop me') {
            return null;
          }
          return {
            ...converted,
            content: [
              ...(converted['content'] as Record<string, unknown>[]),
              { type: 'text', text: 'suffix' },
            ],
          };
        },
        mergeHistory: (history) => [
          ...history,
          { role: 'user', content: [{ type: 'text', text: 'extra' }] },
        ],
        convertTool: (tool) => ({
          name: `x_${tool.name}`,
          description: tool.description,
          input_schema: tool.parameters,
        }),
      },
      { clientFactory: client.clientFactory },
    );
    await requester.generate(
      {
        model,
        tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
      },
      { messages: [createUserMessage('hi'), createUserMessage('drop me')] },
      { signal: new AbortController().signal },
    );
    const body = client.body();
    const bodyMessages = body['messages'] as Record<string, unknown>[];
    expect(bodyMessages).toHaveLength(2);
    expect(bodyMessages[0]?.['content']).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'suffix' },
    ]);
    expect(bodyMessages[1]?.['content']).toEqual([
      { type: 'text', text: 'extra', cache_control: { type: 'ephemeral' } },
    ]);
    const bodyTools = body['tools'] as Record<string, unknown>[];
    expect(bodyTools).toHaveLength(1);
    expect(bodyTools[0]?.['name']).toBe('x_get_weather');
    expect(bodyTools[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
  });
});

describe('anthropic user message merging', () => {
  function bodyMessages(body: Record<string, unknown>): Record<string, unknown>[] {
    return body['messages'] as Record<string, unknown>[];
  }

  async function generate(history: readonly Message[]): Promise<Record<string, unknown>[]> {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      { messages: history },
      { signal: new AbortController().signal },
    );
    return bodyMessages(client.body());
  }

  it('keeps a plain user text and a following tool result separate', async () => {
    const merged = await generate([createUserMessage('hi'), createToolMessage('call_1', 'sunny')]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.['content']).toEqual([{ type: 'text', text: 'hi' }]);
    expect((merged[1]?.['content'] as Record<string, unknown>[])[0]?.['type']).toBe(
      'tool_result',
    );
  });

  it('merges user text into a preceding tool result message', async () => {
    const merged = await generate([createToolMessage('call_1', 'sunny'), createUserMessage('hi')]);
    expect(merged).toHaveLength(1);
    const content = merged[0]?.['content'] as Record<string, unknown>[];
    expect(content.map((block) => block['type'])).toEqual(['tool_result', 'text']);
  });

  it('merges consecutive tool result messages', async () => {
    const merged = await generate([
      createToolMessage('call_1', 'sunny'),
      createToolMessage('call_2', 'rainy'),
    ]);
    expect(merged).toHaveLength(1);
    const content = merged[0]?.['content'] as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content.every((block) => block['type'] === 'tool_result')).toBe(true);
  });

  it('does not merge adjacent assistant messages', async () => {
    const merged = await generate([
      createAssistantMessage([{ type: 'text', text: 'a' }]),
      createAssistantMessage([{ type: 'text', text: 'b' }]),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.['role']).toBe('assistant');
    expect(merged[1]?.['role']).toBe('assistant');
  });
});


describe('anthropic cache control', () => {
  async function generate(
    history: readonly Message[],
    tools: ToolDescription[] = [],
    systemPrompt?: string,
  ): Promise<Record<string, unknown>> {
    const client = stubAnthropicClient(anthropicStreamEvents);
    const requester = createAnthropicRequester(undefined, { clientFactory: client.clientFactory });
    await requester.generate(
      { model, systemPrompt, tools },
      { messages: history },
      { signal: new AbortController().signal },
    );
    return client.body();
  }

  it('marks the last block of the last message and the last tool', async () => {
    const body = await generate(
      [createUserMessage('hi')],
      [
        { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
        { name: 'get_time', description: 'Get time', parameters: { type: 'object' } },
      ],
    );
    const messages = body['messages'] as Record<string, unknown>[];
    const content = messages[0]?.['content'] as Record<string, unknown>[];
    expect(content[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[0]?.['cache_control']).toBeUndefined();
    expect(tools.at(-1)?.['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('marks only the last block', async () => {
    const body = await generate([
      createUserMessage('one'),
      createAssistantMessage([{ type: 'text', text: 'two' }]),
      createUserMessage('three'),
    ]);
    const messages = body['messages'] as Record<string, unknown>[];
    const first = messages[0]?.['content'] as Record<string, unknown>[];
    const assistant = messages[1]?.['content'] as Record<string, unknown>[];
    const last = messages[2]?.['content'] as Record<string, unknown>[];
    expect(first[0]?.['cache_control']).toBeUndefined();
    expect(assistant[0]?.['cache_control']).toBeUndefined();
    expect(last[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('marks a trailing tool result block', async () => {
    const body = await generate([
      createUserMessage('hi'),
      createAssistantMessage(
        [{ type: 'text', text: '' }],
        [{ type: 'function', id: 'call_1', name: 'get_weather', arguments: '{}' }],
      ),
      createToolMessage('call_1', 'sunny'),
    ]);
    const messages = body['messages'] as Record<string, unknown>[];
    const last = messages.at(-1)?.['content'] as Record<string, unknown>[];
    expect(last.at(-1)?.['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('marks the system block', async () => {
    const body = await generate([createUserMessage('hi')], [], 'be brief');
    const system = body['system'] as Record<string, unknown>[];
    expect(system[0]?.['cache_control']).toEqual({ type: 'ephemeral' });
  });
});


describe('anthropic thinking kwargs', () => {
  it('applies the kimi thinking trait, the anthropic-beta protocol, and thinking echo rules', async () => {
    const client = stubAnthropicClient([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'enc_data_1' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const requester = createAnthropicRequester(kimiAnthropicTrait, {
      betaApi: true,
      clientFactory: client.clientFactory,
    });
    const parts: StreamedMessagePart[] = [];
    await requester.generate(
      { model, thinking: { effort: 'high' } },
      {
        messages: [
          createAssistantMessage(
            [{ type: 'think', think: 'reasoning', encrypted: 'sig_1' }],
            [{ type: 'function', id: 'call_1', name: 'get_weather', arguments: '{}' }],
          ),
          createToolMessage('call_1', 'sunny'),
          createUserMessage('hi'),
        ],
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.delta') parts.push(event.part);
        },
      },
    );
    expect(parts).toContainEqual({ type: 'think', think: '', encrypted: 'enc_data_1' });
    let body = client.body();
    expect(body['thinking']).toEqual({ type: 'enabled' });
    expect(body['output_config']).toEqual({ effort: 'high' });
    expect(body['betaFeatures']).toBeUndefined();
    expect(body['betas']).toEqual(['context-management-2025-06-27']);
    expect(body['max_tokens']).toBe(128000);
    expect(client.betaCalled()).toBe(true);
    let bodyMessages = body['messages'] as Record<string, unknown>[];
    expect(bodyMessages[0]?.['content']).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig_1' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
    ]);

    await requester.generate(
      { model, thinking: { effort: 'on', keep: 'all' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toEqual(['context-management-2025-06-27']);
    expect(client.betaCalled()).toBe(true);

    const betaFeatureTrait = {
      withThinking: () => ({
        thinking: { type: 'enabled' },
        betaFeatures: ['interleaved-thinking-2025-05-14', 'custom-beta'],
      }),
    };
    const betaRequester = createAnthropicRequester(betaFeatureTrait, {
      betaApi: true,
      clientFactory: client.clientFactory,
    });
    await betaRequester.generate(
      { model, thinking: { effort: 'on' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['betaFeatures']).toBeUndefined();
    expect(body['betas']).toEqual(['interleaved-thinking-2025-05-14', 'custom-beta']);
    expect(client.betaCalled()).toBe(true);

    await betaRequester.generate(
      { model, thinking: { effort: 'on', keep: 'all' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toEqual([
      'interleaved-thinking-2025-05-14',
      'custom-beta',
      'context-management-2025-06-27',
    ]);

    const plainBetaRequester = createAnthropicRequester(betaFeatureTrait, {
      clientFactory: client.clientFactory,
    });
    await plainBetaRequester.generate(
      { model, thinking: { effort: 'on' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['betaFeatures']).toBeUndefined();
    expect(body['betas']).toBeUndefined();
    expect(client.requestHeaders()?.['anthropic-beta']).toBe(
      'interleaved-thinking-2025-05-14,custom-beta',
    );
    expect(client.betaCalled()).toBe(false);

    const defaultRequester = createAnthropicRequester(undefined, {
      clientFactory: client.clientFactory,
    });
    await defaultRequester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['betas']).toBeUndefined();
    expect(client.requestHeaders()?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(client.betaCalled()).toBe(false);

    await defaultRequester.generate(
      { model, thinking: { effort: 'high' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['betas']).toBeUndefined();
    expect(client.requestHeaders()?.['anthropic-beta']).toBeUndefined();
    expect(client.betaCalled()).toBe(false);

    await defaultRequester.generate(
      { model: { ...model, model: 'claude-sonnet-4-5' }, thinking: { effort: 'high' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    expect(client.requestHeaders()?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(client.betaCalled()).toBe(false);

    await defaultRequester.generate(
      {
        model: {
          ...model,
          model: 'claude-sonnet-4-5',
          supportEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
        thinking: { effort: 'xhigh' },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body['output_config']).toEqual({ effort: 'xhigh' });
    expect(client.requestHeaders()?.['anthropic-beta']).toBeUndefined();

    await defaultRequester.generate(
      {
        model: { ...model, supportEfforts: ['low', 'medium', 'high'], adaptiveThinking: false },
        thinking: { effort: 'high' },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 32000 });
    expect(body['output_config']).toBeUndefined();
    expect(client.requestHeaders()?.['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');

    await defaultRequester.generate(
      { model, thinking: { effort: 'high', keep: 'all' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['context_management']).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(body['betas']).toEqual(['context-management-2025-06-27']);
    expect(client.betaCalled()).toBe(true);

    await requester.generate(
      { model, thinking: { effort: 'off' } },
      { messages },
      { signal: new AbortController().signal },
    );
    body = client.body();
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['output_config']).toBeUndefined();

    const unsignedHistory: Message[] = [
      createAssistantMessage([{ type: 'think', think: 'loose reasoning' }]),
      createUserMessage('hi'),
    ];
    await requester.generate(
      { model, thinking: { effort: 'off' } },
      { messages: unsignedHistory },
      { signal: new AbortController().signal },
    );
    body = client.body();
    bodyMessages = body['messages'] as Record<string, unknown>[];
    expect(bodyMessages[0]?.['content']).toEqual([
      { type: 'thinking', thinking: 'loose reasoning' },
    ]);

    await requester.generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createAssistantMessage([{ type: 'think', think: '' }]),
          createUserMessage('hi'),
        ],
      },
      { signal: new AbortController().signal },
    );
    body = client.body();
    bodyMessages = body['messages'] as Record<string, unknown>[];
    expect(bodyMessages[0]?.['content']).toEqual([{ type: 'thinking', thinking: '' }]);

    await requester.generate(
      { model: { ...model, model: 'claude-sonnet-4-5' }, thinking: { effort: 'off' } },
      { messages: unsignedHistory },
      { signal: new AbortController().signal },
    );
    body = client.body();
    bodyMessages = body['messages'] as Record<string, unknown>[];
    expect(bodyMessages).toHaveLength(1);
    expect(bodyMessages[0]?.['role']).toBe('user');

    const events: LlmRequestEvent[] = [];
    await defaultRequester.generate(
      { model: { ...model, model: 'claude-fable-5' }, thinking: { effort: 'off' } },
      { messages },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    const failed = events.find((event) => event.type === 'llm.failed.syntax');
    expect(failed).toBeDefined();
    if (failed?.type !== 'llm.failed.syntax') throw new Error('expected llm.failed.syntax');
    expect(failed.error.code).toBe('thinking_config');
    expect(failed.error.message).toContain('always reasons');
    expect(events.some((event) => event.type === 'llm.sent')).toBe(false);
  });
});

describe('openai responses base', () => {
  it('builds the responses request shape and parses the stream', async () => {
    const client = stubResponsesClient([
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'r_1', summary: [] },
      },
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'r_1',
          summary: [{ type: 'summary_text', text: 'thinking' }],
          encrypted_content: 'enc_1',
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"city"',
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        output_index: 1,
        arguments: '{"city":"sf"}',
      },
      { type: 'response.output_text.delta', delta: 'sunny' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } },
        },
      },
    ]);
    const requester = createOpenAIResponsesRequester(undefined, {
      clientFactory: client.clientFactory,
    });
    const parts: StreamedMessagePart[] = [];
    let usage: TokenUsage | undefined;
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    await requester.generate(
      {
        model,
        systemPrompt: 'be brief',
        tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
        thinking: { effort: 'high' },
        maxCompletionTokens: 500,
      },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage(
            [
              { type: 'think', think: 'hmm', encrypted: 'enc_0' },
              { type: 'text', text: 'checking' },
            ],
            [{ type: 'function', id: 'call|abc', name: 'get_weather', arguments: '{"city":"sf"}' }],
          ),
          createToolMessage('call|abc', 'sunny'),
        ],
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.delta') parts.push(event.part);
          if (event.type === 'llm.usage') usage = event.usage;
          if (event.type === 'llm.finish') finish = event.finish;
          if (event.type === 'llm.message-id') messageId = event.messageId;
        },
      },
    );
    const body = client.body();
    expect(body['instructions']).toBe('be brief');
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['reasoning']).toEqual({ effort: 'high', summary: 'auto' });
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body['max_output_tokens']).toBe(500);
    const input = body['input'] as Record<string, unknown>[];
    expect(input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    });
    expect(input[1]).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'hmm' }],
      encrypted_content: 'enc_0',
    });
    expect(input[2]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'checking', annotations: [] }],
    });
    expect(input[3]).toEqual({
      type: 'function_call',
      call_id: 'call',
      name: 'get_weather',
      arguments: '{"city":"sf"}',
    });
    expect(input[4]).toEqual({
      type: 'function_call_output',
      call_id: 'call',
      output: [{ type: 'input_text', text: 'sunny' }],
    });
    const bodyTools = body['tools'] as Record<string, unknown>[];
    expect(bodyTools[0]).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object' },
      strict: false,
    });
    expect(usage).toEqual({
      inputOther: 7,
      output: 7,
      inputCacheRead: 5,
      inputCacheCreation: 0,
      raw: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 5 } },
    });
    expect(parts).toContainEqual({ type: 'think', think: 'thinking' });
    expect(parts).toContainEqual({ type: 'think', think: '', encrypted: 'enc_1' });
    expect(parts).toContainEqual({
      type: 'function',
      id: 'call_1',
      name: 'get_weather',
      arguments: '',
      _streamIndex: 'fc_1',
    });
    expect(parts).toContainEqual({
      type: 'tool_call_part',
      argumentsPart: '{"city"',
      index: 'fc_1',
    });
    expect(parts).toContainEqual({
      type: 'tool_call_part',
      argumentsPart: ':"sf"}',
      index: 'fc_1',
    });
    expect(parts).toContainEqual({ type: 'text', text: 'sunny' });
    expect(finish).toEqual({ finishReason: 'completed', rawFinishReason: 'completed' });
    expect(messageId).toBe('resp_1');
  });
});

describe('google genai base', () => {
  it('converts contents and maps usageMetadata', async () => {
    const client = stubGoogleClient([
      {
        responseId: 'gemini-resp-1',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'hmm', thought: true, thoughtSignature: 'sig_1' },
                { text: 'sunny' },
                { functionCall: { name: 'get_weather', args: { city: 'sf' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 4 },
      },
    ]);
    const requester = createGoogleGenAIRequester(undefined, {
      clientFactory: client.clientFactory,
    });
    const parts: StreamedMessagePart[] = [];
    let usage: TokenUsage | undefined;
    let finish: FinishInfo | undefined;
    let messageId: string | undefined;
    await requester.generate(
      {
        model: { ...model, model: 'gemini-2.5-flash', apiKey: 'test-key' },
        systemPrompt: 'be brief',
        tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
        thinking: { effort: 'medium' },
        maxCompletionTokens: 500,
      },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage(
            [
              { type: 'think', think: 'hmm', encrypted: 'sig_0' },
              { type: 'text', text: 'checking' },
            ],
            [
              {
                type: 'function',
                id: 'get_weather_abc',
                name: 'get_weather',
                arguments: '{"city":"sf"}',
                extras: { thought_signature_b64: 'sig_call' },
              },
            ],
          ),
          createToolMessage('get_weather_abc', 'sunny'),
        ],
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.delta') parts.push(event.part);
          if (event.type === 'llm.usage') usage = event.usage;
          if (event.type === 'llm.finish') finish = event.finish;
          if (event.type === 'llm.message-id') messageId = event.messageId;
        },
      },
    );
    const body = client.body();
    const contents = body['contents'] as Record<string, unknown>[];
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] });
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'hmm', thought: true, thoughtSignature: 'sig_0' },
        { text: 'checking' },
        {
          functionCall: { name: 'get_weather', args: { city: 'sf' } },
          thoughtSignature: 'sig_call',
        },
      ],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', response: { output: 'sunny' }, parts: [] } },
      ],
    });
    const config = body['config'] as Record<string, unknown>;
    expect(config['systemInstruction']).toBe('be brief');
    expect(config['maxOutputTokens']).toBe(500);
    expect(config['thinkingConfig']).toEqual({
      includeThoughts: true,
      thinkingBudget: 4096,
    });
    const bodyTools = config['tools'] as Record<string, unknown>[];
    expect(bodyTools[0]).toEqual({
      functionDeclarations: [
        { name: 'get_weather', description: 'Get weather', parametersJsonSchema: { type: 'object' } },
      ],
    });
    expect(usage).toEqual({
      inputOther: 6,
      output: 5,
      inputCacheRead: 4,
      inputCacheCreation: 0,
      raw: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 4 },
    });
    expect(parts).toContainEqual({ type: 'think', think: 'hmm', encrypted: 'sig_1' });
    expect(parts).toContainEqual({ type: 'text', text: 'sunny' });
    const functionPart = parts.find(isToolCall);
    expect(functionPart?.name).toBe('get_weather');
    expect(functionPart?.arguments).toBe('{"city":"sf"}');
    expect(finish).toEqual({ finishReason: 'completed', rawFinishReason: 'STOP' });
    expect(messageId).toBe('gemini-resp-1');
  });
});
