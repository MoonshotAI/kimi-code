import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  createMemoryProviderCatalogStore,
  createProviderCatalog,
  type CatalogModel,
  type CatalogModelDefinition,
  type CatalogProviderHandle,
  type ProviderCatalogRefreshFailedEvent,
} from '#/llm/catalog/index';
import { createUserMessage } from '#/llm/message';
import type { Protocol } from '#/llm/protocol/protocol';
import { createRequester, type LlmRequester } from '#/llm/requester';
import type { LlmRemoteErrorMessage } from '#/llm/response';

const modelDef: CatalogModelDefinition = {
  id: 'm1',
  provider: 'test',
  capability: {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
  },
  maxContextSize: 4096,
};

function stubProtocol(
  handler: (module: unknown, endpoint: unknown) => string | LlmRemoteErrorMessage,
): Protocol<Record<string, unknown>, { module: unknown }, string, string, { endpoint: unknown }> {
  return {
    media: { kinds: {} },
    encode: (module) => ({ module }),
    decode: (_module, response, sink) => {
      sink.onDelta({ type: 'text', text: response });
      sink.onFinish({ finishReason: 'completed', rawFinishReason: 'stop' });
    },
    decodeStream: () => (chunk, sink) => {
      sink.onDelta({ type: 'text', text: chunk });
      sink.onFinish({ finishReason: 'completed', rawFinishReason: 'stop' });
    },
    decodeError: (error) => error as LlmRemoteErrorMessage,
    client: (endpoint) => ({ endpoint }),
    send: async (client, request) => {
      const out = handler(request.module, client.endpoint);
      if (typeof out !== 'string') throw out;
      return { body: out };
    },
    sendStream: async (client, request) => {
      const out = handler(request.module, client.endpoint);
      if (typeof out !== 'string') throw out;
      return {
        body: (async function* () {
          yield out;
        })(),
      };
    },
  };
}

function remoteStatusError(message: string): LlmRemoteErrorMessage {
  return {
    kind: 'status',
    statusCode: 500,
    message,
    requestId: null,
    retryAfterMs: null,
    headers: null,
  };
}

function failingRequester(message: string): LlmRequester<'protocol'> {
  return createRequester().with({
    protocol: { base: stubProtocol(() => remoteStatusError(message)) },
  });
}

function stubHandle(
  id: string,
  requester: LlmRequester<'protocol'> = failingRequester('unused'),
  listModels?: () => Promise<readonly CatalogModelDefinition[]>,
): CatalogProviderHandle {
  return {
    id,
    requester,
    listModels,
  };
}

function byId(models: readonly CatalogModel[]): Map<string, CatalogModel> {
  return new Map(models.map((model) => [model.id, model]));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

describe('providerCatalog store, merge and refresh', () => {
  it('adds, refreshes in one batch, merges discovered and override models, removes, and persists through the store', async () => {
    const store = createMemoryProviderCatalogStore({
      providers: {
        openai: {
          discovered: {},
          override: {},
          info: { customHeaders: { 'x-keep': '1' } },
        },
      },
    });
    const catalog = await createProviderCatalog({ store });
    expect(catalog.providers()).toEqual(['openai']);
    expect(catalog.models('openai')).toEqual([]);

    let addPulls = 0;
    const countPullHandle = (id: string): CatalogProviderHandle =>
      stubHandle(id, undefined, async () => {
        addPulls += 1;
        return [];
      });

    catalog.upsert({
      handle: countPullHandle('openai'),
      info: { customHeaders: { 'x-keep': '2' } },
      models: [
        {
          id: 'gpt-5',
          provider: 'openai',
          displayName: 'GPT-5 Turbo',
          maxContextSize: 400000,
          maxInputSize: 272000,
          maxOutputTokens: 64000,
          capability: {
            image_in: true,
            thinking: true,
            tool_use: true,
          },
          thinking: {
            supportEfforts: ['low', 'high'],
          },
        },
        {
          id: 'gpt-5-wire',
          provider: 'openai',
          name: 'gpt-5-alias',
          aliases: ['g5w'],
          maxContextSize: 128000,
          maxInputSize: 200000,
          capability: {
            image_in: false,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          endpoint: {
            baseUrl: 'https://custom.example.test/v1',
            headers: { 'x-key': 'v' },
          },
        },
      ],
    });
    catalog.upsert({
      handle: countPullHandle('anthropic'),
      info: { defaultModel: 'claude-sonnet-4-5' },
      models: [
        {
          id: 'claude-sonnet-4-5',
          provider: 'anthropic',
          capability: {
            image_in: true,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          maxContextSize: 200000,
        },
      ],
    });

    await until(() => addPulls === 2);
    expect(catalog.providerInfo('openai')?.customHeaders).toEqual({ 'x-keep': '2' });

    const fromAdded = catalog.model('openai', 'gpt-5');
    expect(fromAdded?.capability.image_in).toBe(true);
    expect(fromAdded?.maxContextSize).toBe(400000);
    expect(fromAdded?.maxInputSize).toBe(272000);
    expect(fromAdded?.maxOutputTokens).toBe(64000);
    expect(fromAdded?.displayName).toBe('GPT-5 Turbo');
    expect(fromAdded?.thinking?.supportEfforts).toEqual(['low', 'high']);

    const withWire = catalog.model('openai', 'gpt-5-wire');
    expect(withWire?.name).toBe('gpt-5-alias');
    expect(withWire?.maxInputSize).toBe(128000);
    expect(withWire?.endpoint?.baseUrl).toBe('https://custom.example.test/v1');
    expect(withWire?.endpoint?.headers).toEqual({ 'x-key': 'v' });

    expect(catalog.models('openai').map((model) => model.id)).toEqual(['gpt-5', 'gpt-5-wire']);
    expect(catalog.models('anthropic').map((model) => model.id)).toEqual(['claude-sonnet-4-5']);
    expect(catalog.providerInfo('anthropic')?.defaultModel).toBe('claude-sonnet-4-5');

    const changes: string[][] = [];
    catalog.onChanged((event) => changes.push([...event.providers]));

    let openaiPulls = 0;
    let googlePulls = 0;
    const openaiHandle = stubHandle('openai', undefined, async () => {
      openaiPulls += 1;
      return [
        {
          id: 'gpt-5',
          capability: {
            image_in: false,
            video_in: true,
            audio_in: false,
            thinking: true,
            tool_use: true,
          },
          thinking: {
            supportEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
          maxContextSize: 100000,
        },
        {
          id: 'gpt-5-alias',
          displayName: 'Discovered Alias Target',
          capability: {
            audio_in: true,
          },
        },
        {
          id: 'gpt-mini',
          capability: {
            image_in: false,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          maxContextSize: 32000,
          endpoint: { baseUrl: 'https://seed.test/v1' },
        },
      ];
    });
    const googleHandle = stubHandle('google', undefined, async () => {
      googlePulls += 1;
      return [
        {
          id: 'gemini-4',
          capability: {
            image_in: true,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          maxContextSize: 1000000,
        },
      ];
    });

    catalog.refresh(openaiHandle);
    catalog.refresh(openaiHandle);
    catalog.refresh(googleHandle);
    await until(() => changes.length === 1);
    expect(openaiPulls).toBe(1);
    expect(googlePulls).toBe(1);
    expect(changes).toEqual([['google', 'openai']]);

    const merged = catalog.model('openai', 'gpt-5');
    expect(merged?.capability.image_in).toBe(true);
    expect(merged?.capability.video_in).toBe(true);
    expect(merged?.capability.thinking).toBe(true);
    expect(merged?.maxContextSize).toBe(400000);
    expect(merged?.thinking?.supportEfforts).toEqual(['low', 'high']);
    expect(merged?.thinking?.defaultEffort).toBeUndefined();

    const matchedByName = catalog.model('openai', 'gpt-5-wire');
    expect(matchedByName?.displayName).toBe('Discovered Alias Target');
    expect(matchedByName?.capability.audio_in).toBe(false);

    const discoveredOnly = catalog.model('openai', 'gpt-mini');
    expect(discoveredOnly?.maxContextSize).toBe(32000);
    expect(discoveredOnly?.endpoint?.baseUrl).toBe('https://seed.test/v1');
    expect(catalog.model('google', 'gemini-4')?.maxContextSize).toBe(1000000);
    expect(catalog.model('openai', 'no-such-model')).toBeUndefined();
    expect(catalog.models('openai').map((model) => model.id)).toEqual([
      'gpt-5',
      'gpt-5-alias',
      'gpt-5-wire',
      'gpt-mini',
    ]);
    expect(catalog.providers()).toEqual(['anthropic', 'google', 'openai']);

    const failingHandle = stubHandle('openai', undefined, () => Promise.reject(new Error('boom')));
    const failures: ProviderCatalogRefreshFailedEvent[] = [];
    catalog.onRefreshFailed((event) => failures.push(event));
    catalog.refresh(failingHandle);
    await until(() => failures.length === 1);
    expect(failures[0]?.providerId).toBe('openai');
    expect((failures[0]?.error as Error).message).toBe('boom');
    expect(byId(catalog.models('openai')).get('gpt-mini')?.maxContextSize).toBe(32000);
    expect(changes).toHaveLength(1);

    catalog.upsert({
      handle: countPullHandle('anthropic'),
      info: { defaultModel: 'claude-fable-5' },
    });
    await until(() => changes.length === 3);
    expect(catalog.models('anthropic')).toEqual([]);
    expect(catalog.providerInfo('anthropic')?.defaultModel).toBe('claude-fable-5');
    expect(changes).toEqual([['google', 'openai'], ['anthropic'], ['anthropic']]);

    catalog.remove('anthropic');
    expect(catalog.providers()).toEqual(['google', 'openai']);
    expect(catalog.models('anthropic')).toEqual([]);
    expect(changes).toEqual([['google', 'openai'], ['anthropic'], ['anthropic'], ['anthropic']]);

    const reopened = await createProviderCatalog({ store });
    expect(reopened.providers()).toEqual(['google', 'openai']);
    expect(reopened.models('openai')).toHaveLength(4);
    expect(reopened.model('openai', 'gpt-5')?.maxContextSize).toBe(400000);
    expect(reopened.model('google', 'gemini-4')?.maxContextSize).toBe(1000000);
    expect(reopened.models('anthropic')).toEqual([]);
    expect(reopened.providerInfo('openai')?.customHeaders).toEqual({ 'x-keep': '2' });
    expect(reopened.providerInfo('anthropic')).toBeUndefined();
    catalog.close();
    reopened.close();
  });
});

describe('providerCatalog requester resolution', () => {
  it('builds a ready-to-generate requester by layering provider, info and model dimensions', async () => {
    const captured: { module?: unknown; endpoint?: unknown } = {};
    const openaiBase = createRequester().with({
      protocol: {
        base: stubProtocol((module, endpoint) => {
          captured.module = module;
          captured.endpoint = endpoint;
          return 'hello from catalog';
        }),
        options: { providerPreset: true },
      },
      endpoint: {
        defaultBaseUrl: 'https://default.example.test/v1',
      },
    });
    const anthropicBase = createRequester().with({
      protocol: {
        base: anthropicProtocol,
        options: { betaApi: true },
      },
    });

    const catalog = await createProviderCatalog();
    catalog.upsert({
      providerId: 'kimi',
      refresh: false,
      info: {
        baseUrl: 'https://provider.example.test/v1',
        customHeaders: { 'x-provider': '1', 'x-override': 'provider' },
      },
      handle: {
        id: 'kimi',
        requester: {
          openai: openaiBase,
          anthropic: anthropicBase,
        },
        endpoint: {
          headers: { 'x-handle': '1', 'x-override': 'handle' },
          credentials: { resolve: () => ({ apiKey: 'sk-catalog' }) },
        },
      },
      models: [
        {
          id: 'k2-chat',
          provider: 'kimi',
          name: 'kimi-k2-0905',
          maxContextSize: 256000,
          maxOutputTokens: 8192,
          sampling: { temperature: 0.6 },
          defaultThinking: { effort: 'high' },
          protocolOptions: { reasoningKey: 'reasoning_content' },
          endpoint: {
            headers: { 'x-model': '1', 'x-override': 'model' },
          },
        },
        {
          id: 'k2-anthropic',
          provider: 'kimi',
          protocol: 'anthropic',
          maxContextSize: 200000,
          protocolOptions: { extras: { top_k: 10 } },
          endpoint: {
            baseUrl: 'https://anthropic.example.test',
          },
        },
      ],
    });

    const chatRequester = catalog.requester('kimi', 'k2-chat');
    expect(chatRequester).toBeDefined();
    const outcome = await chatRequester!.generate(
      {
        content: { messages: [createUserMessage('hi')] },
      },
      { signal: new AbortController().signal },
    );
    expect(outcome.type).toBe('done');
    expect(captured.endpoint).toEqual({
      baseUrl: 'https://provider.example.test/v1',
      apiKey: 'sk-catalog',
      headers: {
        'x-handle': '1',
        'x-provider': '1',
        'x-model': '1',
        'x-override': 'model',
      },
      fetch: undefined,
    });
    expect(captured.module).toMatchObject({
      model: {
        spec: {
          provider: 'kimi',
          name: 'kimi-k2-0905',
          maxContextSize: 256000,
        },
        maxOutputTokens: 8192,
        sampling: { temperature: 0.6 },
        thinking: { effort: 'high' },
      },
      options: {
        providerPreset: true,
        reasoningKey: 'reasoning_content',
      },
    });

    const anthropicReq = catalog
      .requester('kimi', 'k2-anthropic')
      ?.request({ content: { messages: [createUserMessage('hi')] } });
    expect(anthropicReq?.protocol.base).toBe(anthropicProtocol);
    expect(anthropicReq?.protocol.options).toEqual({
      betaApi: true,
      extras: { top_k: 10 },
    });
    expect(anthropicReq?.endpoint?.baseUrl).toBe('https://anthropic.example.test');

    const customFetch = (async () => new Response()) as unknown as typeof fetch;
    const deepMerged = openaiBase
      .with({
        endpoint: { fetch: customFetch, baseUrl: 'https://keep.example.test', headers: { a: '1' } },
        model: { spec: { provider: 'kimi', name: 'k2', capability: { thinking: true } } },
      })
      .with({
        endpoint: { baseUrl: undefined, headers: { b: '2' } },
        model: { spec: { provider: 'kimi', name: 'k2', maxContextSize: 128000 } },
      })
      .request({ content: { messages: [createUserMessage('hi')] } });
    expect(deepMerged.endpoint?.fetch).toBe(customFetch);
    expect(deepMerged.endpoint?.baseUrl).toBe('https://keep.example.test');
    expect(deepMerged.endpoint?.headers).toEqual({ a: '1', b: '2' });
    expect(deepMerged.model.spec).toEqual({
      provider: 'kimi',
      name: 'k2',
      capability: { thinking: true },
      maxContextSize: 128000,
    });

    expect(catalog.requester('kimi', 'missing')).toBeUndefined();
    expect(catalog.requester('missing', 'k2-chat')).toBeUndefined();
    catalog.close();
  });
});

describe('providerCatalog ping', () => {
  it('marks a failing model and emits changed, then clears the mark after a successful ping', async () => {
    let failing = true;
    const requester = createRequester().with({
      protocol: {
        base: stubProtocol(() => (failing ? remoteStatusError('boom') : 'pong')),
      },
    });
    const catalog = await createProviderCatalog();
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));
    catalog.upsert({
      handle: stubHandle('test', requester, async () => []),
      models: [modelDef],
    });
    await until(() => changed.length >= 2);

    changed.length = 0;
    catalog.ping('test', 'm1');
    await until(() => catalog.model('test', 'm1')?.pingError === 'boom');
    expect(changed).toEqual([['test']]);

    failing = false;
    changed.length = 0;
    catalog.ping('test', 'm1');
    await until(() => changed.length > 0);
    expect(catalog.model('test', 'm1')?.pingError).toBeUndefined();
    catalog.close();
  });

  it('ignores pings for unknown providers and models', async () => {
    const catalog = await createProviderCatalog();
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));
    catalog.upsert({
      handle: stubHandle('test', failingRequester('boom'), async () => []),
      models: [modelDef],
    });
    await until(() => changed.length >= 2);

    changed.length = 0;
    catalog.ping('nope', 'm1');
    catalog.ping('test', 'nope');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(changed).toEqual([]);
    expect(catalog.model('test', 'm1')?.pingError).toBeUndefined();
    catalog.close();
  });

  it('pings through the latest provider handle after a re-upsert', async () => {
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: stubHandle('test', failingRequester('first'), async () => []),
      models: [modelDef],
    });
    catalog.upsert({
      handle: stubHandle('test', failingRequester('second'), async () => []),
      models: [modelDef],
    });

    catalog.ping('test', 'm1');

    await until(() => catalog.model('test', 'm1')?.pingError === 'second');
    expect(catalog.model('test', 'm1')?.pingError).toBe('second');
    catalog.close();
  });

  it('carries the model protocol and protocolOptions into the ping request', async () => {
    const seen: { protocol?: string; options?: unknown; modelName?: string }[] = [];
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: {
        id: 'test',
        requester: (protocol) =>
          createRequester().with({
            protocol: {
              base: stubProtocol((module) => {
                const mod = module as {
                  model: { spec: { name: string } };
                  options: unknown;
                };
                seen.push({
                  protocol,
                  options: mod.options,
                  modelName: mod.model.spec.name,
                });
                return 'pong';
              }),
            },
          }),
      },
      models: [
        {
          ...modelDef,
          protocol: 'anthropic',
          protocolOptions: { betaApi: true },
        },
      ],
    });

    catalog.ping('test', 'm1');

    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({
      protocol: 'anthropic',
      options: { betaApi: true },
      modelName: 'm1',
    });
    expect(openAIProtocol).toBeDefined();
    catalog.close();
  });

  it('defers a ping sent while refreshing until the refresh completes', async () => {
    let pulls = 0;
    let resolvePull: (models: readonly CatalogModelDefinition[]) => void = () => {};
    const handle = stubHandle('test', failingRequester('boom'), () => {
      pulls += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    });
    const catalog = await createProviderCatalog();
    catalog.upsert({ handle, models: [modelDef] });
    await until(() => pulls === 1);

    catalog.ping('test', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(catalog.model('test', 'm1')?.pingError).toBeUndefined();

    resolvePull([]);
    await until(() => catalog.model('test', 'm1')?.pingError === 'boom');
    catalog.close();
  });
});
