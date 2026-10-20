import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
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
  handler: (
    module: unknown,
    endpoint: unknown,
    signal: AbortSignal,
  ) => string | LlmRemoteErrorMessage | null,
  before?: () => Promise<void>,
): Protocol<
  Record<string, unknown>,
  { module: unknown },
  string | null,
  string,
  { endpoint: unknown }
> {
  return {
    media: { kinds: {} },
    encode: (module) => ({ module }),
    decoder: (_module, sink) => ({
      push: (chunk) => {
        sink.onDelta({ type: 'text', text: chunk });
        sink.onUsage({ inputOther: 3, output: 4 });
        sink.onFinish({ finishReason: 'completed', rawFinishReason: 'stop' });
      },
      end: () => {},
    }),
    replay: (response) => (response === null ? [] : [response]),
    decodeError: (error) => error as LlmRemoteErrorMessage,
    client: (endpoint) => ({ endpoint }),
    send: (client, request, signal) => {
      const run = () => {
        const out = handler(request.module, client.endpoint, signal);
        if (typeof out !== 'string' && out !== null) return Promise.reject(out);
        return Promise.resolve({ body: out });
      };
      return before === undefined ? run() : before().then(run);
    },
    sendStream: (client, request, signal) => {
      const run = () => {
        const out = handler(request.module, client.endpoint, signal);
        if (typeof out !== 'string' && out !== null) return Promise.reject(out);
        return Promise.resolve({
          body: (async function* () {
            if (out !== null) yield out;
          })(),
        });
      };
      return before === undefined ? run() : before().then(run);
    },
  };
}

function remoteStatusError(message: string, statusCode = 500): LlmRemoteErrorMessage {
  return {
    kind: 'status',
    statusCode,
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
  it('returns success and failure results while updating ping errors and changed events', async () => {
    let mode: 'fail' | 'success' | 'empty' = 'fail';
    const requester = createRequester().with({
      protocol: {
        base: stubProtocol(() => {
          if (mode === 'fail') return remoteStatusError('boom');
          return mode === 'success' ? '  pong  ' : null;
        }),
      },
    });
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: stubHandle('test', requester),
      models: [modelDef],
      refresh: false,
    });
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));

    const failure = await catalog.ping('test', 'm1');
    expect(failure).toEqual({
      ok: false,
      durationMs: expect.any(Number),
      error: 'boom',
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(catalog.model('test', 'm1')?.pingError).toBe('boom');
    expect(changed).toEqual([['test']]);

    mode = 'success';
    changed.length = 0;
    const success = await catalog.ping('test', 'm1');
    expect(success).toEqual({
      ok: true,
      durationMs: expect.any(Number),
      text: 'pong',
      usage: {
        inputOther: 3,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'completed',
    });
    expect(success.durationMs).toBeGreaterThanOrEqual(0);
    expect(catalog.model('test', 'm1')?.pingError).toBeUndefined();
    expect(changed).toEqual([['test']]);

    mode = 'empty';
    changed.length = 0;
    const empty = await catalog.ping('test', 'm1');
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('empty response');
    expect(catalog.model('test', 'm1')?.pingError).toContain('empty response');
    expect(changed).toEqual([['test']]);
    catalog.close();
  });

  it('rejects unknown models and models whose requester cannot be materialized', async () => {
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: stubHandle('test', failingRequester('boom')),
      models: [modelDef],
      refresh: false,
    });
    catalog.upsert({
      providerId: 'bare',
      handle: { id: 'bare' },
      models: [{ ...modelDef, provider: 'bare' }],
      refresh: false,
    });
    const changed: string[][] = [];
    catalog.onChanged((event) => changed.push([...event.providers]));

    await expect(catalog.ping('nope', 'm1')).rejects.toThrow('Unknown model nope/m1');
    await expect(catalog.ping('test', 'nope')).rejects.toThrow('Unknown model test/nope');
    await expect(catalog.ping('bare', 'm1')).rejects.toThrow(
      'No requester configured for bare/m1',
    );

    expect(changed).toEqual([]);
    expect(catalog.model('test', 'm1')?.pingError).toBeUndefined();
    catalog.close();
  });

  it('deduplicates in-flight pings and uses the latest provider handle', async () => {
    let firstCalls = 0;
    let starts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRequester = createRequester().with({
      protocol: {
        base: stubProtocol(() => {
          firstCalls += 1;
          return remoteStatusError('first');
        }),
      },
    });
    const latestRequester = createRequester().with({
      protocol: {
        base: stubProtocol(
          () => 'second',
          async () => {
            starts += 1;
            await gate;
          },
        ),
      },
    });
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: stubHandle('test', firstRequester),
      models: [modelDef],
      refresh: false,
    });
    catalog.upsert({
      handle: stubHandle('test', latestRequester),
      models: [modelDef],
      refresh: false,
    });

    const pending = catalog.ping('test', 'm1');
    const duplicate = catalog.ping('test', 'm1');
    expect(duplicate).toBe(pending);
    await until(() => starts === 1);
    expect(firstCalls).toBe(0);

    release();
    await expect(pending).resolves.toMatchObject({ ok: true, text: 'second' });
    expect(starts).toBe(1);
    catalog.close();
  });

  it('recovers OAuth once with the same signal and preserves the pong request', async () => {
    const seen: {
      protocol?: string;
      options?: unknown;
      modelName?: string;
      maxOutputTokens?: number;
      systemPrompt?: string;
      tools?: unknown;
      messages?: unknown;
      apiKey?: string;
      signal?: AbortSignal;
    }[] = [];
    let attempts = 0;
    let recoveries = 0;
    let invalidations = 0;
    let alwaysFail = false;
    let apiKey = 'stale';
    const credentials = {
      resolve: () => ({ apiKey }),
      canRecover: (error: unknown) => {
        recoveries += 1;
        return (error as { statusCode?: number }).statusCode === 401;
      },
      invalidate: () => {
        invalidations += 1;
        apiKey = 'fresh';
      },
    };
    const catalog = await createProviderCatalog();
    catalog.upsert({
      handle: {
        id: 'test',
        endpoint: { credentials },
        requester: (protocol) =>
          createRequester().with({
            protocol: {
              base: stubProtocol((module, endpoint, signal) => {
                attempts += 1;
                const mod = module as {
                  model: { spec: { name: string }; maxOutputTokens: number };
                  options: unknown;
                  profile: { systemPrompt?: string; tools?: unknown };
                  content: { messages: unknown };
                };
                seen.push({
                  protocol,
                  options: mod.options,
                  modelName: mod.model.spec.name,
                  maxOutputTokens: mod.model.maxOutputTokens,
                  systemPrompt: mod.profile.systemPrompt,
                  tools: mod.profile.tools,
                  messages: mod.content.messages,
                  apiKey: (endpoint as { apiKey?: string }).apiKey,
                  signal,
                });
                if (attempts === 2 && !alwaysFail) return 'pong';
                return remoteStatusError('expired', 401);
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
      refresh: false,
    });

    const recovered = await catalog.ping('test', 'm1');
    expect(recovered).toMatchObject({ ok: true, text: 'pong' });
    expect(attempts).toBe(2);
    expect(recoveries).toBe(1);
    expect(invalidations).toBe(1);
    expect(seen[0]).toMatchObject({
      protocol: 'anthropic',
      options: { betaApi: true },
      modelName: 'm1',
      maxOutputTokens: 512,
      systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
      tools: [],
      apiKey: 'stale',
    });
    expect(seen[0]?.messages).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    ]);
    expect(seen[1]?.apiKey).toBe('fresh');
    expect(seen[1]?.signal).toBe(seen[0]?.signal);

    alwaysFail = true;
    const failed = await catalog.ping('test', 'm1');
    expect(failed).toMatchObject({ ok: false, error: 'expired' });
    expect(attempts).toBe(4);
    expect(recoveries).toBe(2);
    expect(invalidations).toBe(2);
    expect(seen[3]?.signal).toBe(seen[2]?.signal);
    catalog.close();
  });

  it('defers pings during refresh, times out only when configured, and closes all waiters', async () => {
    let pulls = 0;
    let starts = 0;
    let resolvePull: (models: readonly CatalogModelDefinition[]) => void = () => {};
    const waitingRequester = createRequester().with({
      protocol: {
        base: stubProtocol(
          () => 'pong',
          () => {
            starts += 1;
            return new Promise<void>(() => {});
          },
        ),
      },
    });
    const handle = stubHandle('test', waitingRequester, () => {
      pulls += 1;
      return new Promise((resolve) => {
        resolvePull = resolve;
      });
    });
    const catalog = await createProviderCatalog({ pingTimeoutMs: 5 });
    catalog.upsert({ handle, models: [modelDef] });
    await until(() => pulls === 1);

    const deferred = catalog.ping('test', 'm1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(0);
    resolvePull([]);
    const timedOut = await deferred;
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBeTruthy();
    expect(starts).toBe(1);
    catalog.close();

    let closeStarts = 0;
    const closeRequester = createRequester().with({
      protocol: {
        base: stubProtocol(
          () => 'pong',
          () => {
            closeStarts += 1;
            return new Promise<void>(() => {});
          },
        ),
      },
    });
    const closing = await createProviderCatalog();
    closing.upsert({
      handle: stubHandle('test', closeRequester),
      models: [
        modelDef,
        { ...modelDef, id: 'm2' },
        { ...modelDef, id: 'm3' },
      ],
      refresh: false,
    });
    const active = closing.ping('test', 'm1');
    const queued = closing.ping('test', 'm2');
    const last = closing.ping('test', 'm3');
    await until(() => closeStarts === 1);

    closing.close();
    const results = await Promise.all([active, queued, last]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: 'Provider catalog is closed' });
    }
    expect(closeStarts).toBe(1);
  });
});
