import { describe, expect, it } from 'vitest';

import { modelsDevProviderModels, resolveModelsDevImport } from '#/models-dev/models-dev';
import type { Provider } from '#/llm/provider/definition';
import {
  createMemoryProviderCatalogStore,
  createProviderCatalog,
  type CatalogModelDefinition,
  type ProviderCatalogRefreshFailed,
} from '#/llm/provider-catalog';

function byId(
  models: readonly CatalogModelDefinition[],
): Map<string, CatalogModelDefinition> {
  return new Map(models.map((model) => [model.model, model]));
}

describe('resolveModelsDevImport', () => {
  it('resolves the wire and the endpoint decision', () => {
    expect(resolveModelsDevImport({ id: 'anthropic', npm: '@ai-sdk/anthropic' })).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
    });
    expect(resolveModelsDevImport({ id: 'openai', npm: '@ai-sdk/openai' })).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: false,
    });
    expect(
      resolveModelsDevImport({ id: 'google-vertex', npm: '@ai-sdk/google-vertex' }),
    ).toEqual({ kind: 'ok', wire: 'google-vertex', guessed: false });
    expect(resolveModelsDevImport({ id: 'gemini', npm: '@ai-sdk/google' })).toMatchObject({
      kind: 'ok',
      wire: 'google-genai',
    });
    expect(resolveModelsDevImport({ id: 'x', type: 'openai_responses' })).toEqual({
      kind: 'needs-base-url',
      wire: 'openai_responses',
      guessed: false,
    });
    expect(resolveModelsDevImport({ id: 'x', type: 'not-a-wire' })).toEqual({
      kind: 'invalid',
      reason: 'unknown-explicit-type',
    });
    expect(
      resolveModelsDevImport({ id: 'x', type: 'kokub', npm: '@ai-sdk/openai-compatible' }),
    ).toEqual({ kind: 'invalid', reason: 'unknown-explicit-type' });
    expect(
      resolveModelsDevImport({ id: 'amazon-bedrock', npm: '@ai-sdk/amazon-bedrock' }),
    ).toEqual({ kind: 'invalid', reason: 'proprietary-sdk' });
    expect(resolveModelsDevImport({ id: 'cohere', npm: '@ai-sdk/cohere' })).toEqual({
      kind: 'invalid',
      reason: 'proprietary-sdk',
    });
    expect(resolveModelsDevImport({ id: 'xai', npm: '@ai-sdk/xai' })).toEqual({
      kind: 'needs-base-url',
      wire: 'openai',
      guessed: true,
    });
    expect(
      resolveModelsDevImport({
        id: 'kimi-for-coding',
        npm: '@ai-sdk/anthropic',
        api: 'https://api.kimi.com/coding/v1',
      }),
    ).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://api.kimi.com/coding',
    });
    expect(
      resolveModelsDevImport({
        id: 'openrouter',
        npm: '@openrouter/ai-sdk-provider',
        api: 'https://openrouter.ai/api/v1',
      }),
    ).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: true,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(
      resolveModelsDevImport({
        id: 'neon',
        npm: '@ai-sdk/openai-compatible',
        api: '${NEON_BASE_URL}/v1',
      }),
    ).toEqual({ kind: 'needs-base-url', wire: 'openai', guessed: false });
    expect(resolveModelsDevImport({ id: 'xai', npm: '@ai-sdk/xai' }, ' https://api.x.ai/v1 ')).toEqual(
      { kind: 'ok', wire: 'openai', guessed: true, baseUrl: 'https://api.x.ai/v1' },
    );
    expect(
      resolveModelsDevImport(
        { id: 'google-vertex-anthropic', npm: '@ai-sdk/google-vertex/anthropic' },
        'https://gateway.example.test/v1',
      ),
    ).toEqual({
      kind: 'ok',
      wire: 'anthropic',
      guessed: false,
      baseUrl: 'https://gateway.example.test',
    });
    expect(
      resolveModelsDevImport(
        { id: 'openai', npm: '@ai-sdk/openai', api: 'https://api.openai.com/v1' },
        'https://proxy.example.test/v1',
      ),
    ).toEqual({
      kind: 'ok',
      wire: 'openai',
      guessed: false,
      baseUrl: 'https://proxy.example.test/v1',
    });
    expect(resolveModelsDevImport({ id: 'x', type: 'openai' }, '   ')).toEqual({
      kind: 'invalid',
      reason: 'empty-base-url',
    });
    expect(
      resolveModelsDevImport({ id: 'x', type: 'openai' }, 'https://${HOST}.example.test'),
    ).toEqual({ kind: 'invalid', reason: 'placeholder-base-url' });
  });
});

describe('modelsDevProviderModels', () => {
  it('normalizes entries and applies overrides', () => {
    const models = byId(
      modelsDevProviderModels('openai', {
        id: 'openai',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            limit: { context: 400000, input: 272000, output: 128000 },
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            modalities: { input: ['text', 'image', 'video', 'audio'], output: ['text'] },
            interleaved: { field: 'reasoning_details' },
          },
          'grok-4': {
            id: 'grok-4',
            limit: { context: 256000 },
            reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
          },
          'null-tier': {
            id: 'null-tier',
            limit: { context: 64000 },
            reasoning_options: [{ type: 'effort', values: [null, 'low'] }],
          },
          'gpt-5-pro': {
            id: 'gpt-5-pro',
            limit: { context: 400000, input: 500000 },
            reasoning_options: [{ type: 'effort', values: ['medium', 'high'] }],
          },
          'toggle-model': {
            id: 'toggle-model',
            limit: { context: 128000 },
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }],
            tool_call: false,
          },
          'old-model': { id: 'old-model', limit: { context: 8000 }, status: 'deprecated' },
          'alpha-model': { id: 'alpha-model', limit: { context: 8000 }, status: 'alpha' },
          'text-embedding-3': { id: 'text-embedding-3', limit: { context: 8000 } },
          'image-only': {
            id: 'image-only',
            limit: { context: 8000 },
            modalities: { output: ['image'] },
          },
          'no-limit': { id: 'no-limit' },
        },
      }),
    );
    const gpt5 = models.get('gpt-5');
    expect(gpt5?.displayName).toBe('GPT-5');
    expect(gpt5?.capability).toEqual({
      image_in: true,
      video_in: true,
      audio_in: true,
      thinking: true,
      tool_use: true,
      dynamically_loaded_tools: false,
    });
    expect(gpt5?.maxContextSize).toBe(400000);
    expect(gpt5?.maxInputSize).toBe(272000);
    expect(gpt5?.maxOutputSize).toBe(128000);
    expect(gpt5?.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(gpt5?.offEffort).toBeUndefined();
    expect(gpt5?.alwaysThinking).toBe(true);
    expect(gpt5?.reasoningKey).toBe('reasoning_details');
    const grok = models.get('grok-4');
    expect(grok?.supportEfforts).toEqual(['low', 'high']);
    expect(grok?.offEffort).toBe('none');
    expect(models.get('null-tier')?.offEffort).toBe('none');
    const pro = models.get('gpt-5-pro');
    expect(pro?.maxInputSize).toBe(400000);
    expect(pro?.alwaysThinking).toBe(true);
    const toggle = models.get('toggle-model');
    expect(toggle?.capability.thinking).toBe(true);
    expect(toggle?.capability.tool_use).toBe(false);
    expect(toggle?.supportEfforts).toBeUndefined();
    expect(models.has('old-model')).toBe(false);
    expect(models.has('alpha-model')).toBe(false);
    expect(models.has('text-embedding-3')).toBe(false);
    expect(models.has('image-only')).toBe(false);
    expect(models.has('no-limit')).toBe(false);
    const gateway = byId(
      modelsDevProviderModels('zenmux', {
        id: 'zenmux',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://zenmux.example.test/api/v1',
        models: {
          'claude-via-gateway': {
            id: 'claude-via-gateway',
            limit: { context: 200000 },
            provider: {
              npm: '@ai-sdk/anthropic',
              api: 'https://zenmux.example.test/api/anthropic/v1',
            },
          },
          'same-wire-custom-endpoint': {
            id: 'same-wire-custom-endpoint',
            limit: { context: 32000 },
            provider: { api: 'https://special.example.test/v1' },
          },
          'placeholder-override': {
            id: 'placeholder-override',
            limit: { context: 32000 },
            provider: { npm: '@ai-sdk/openai', api: '${PLACEHOLDER}/v1' },
          },
          'bedrock-override': {
            id: 'bedrock-override',
            limit: { context: 32000 },
            provider: { npm: '@ai-sdk/amazon-bedrock' },
          },
        },
      }),
    );
    const claude = gateway.get('claude-via-gateway');
    expect(claude?.protocol).toBe('anthropic');
    expect(claude?.baseUrl).toBe('https://zenmux.example.test/api/anthropic');
    expect(claude?.supportEfforts).toBeUndefined();
    expect(claude?.capability.thinking).toBe(false);
    expect(gateway.get('same-wire-custom-endpoint')?.baseUrl).toBe(
      'https://special.example.test/v1',
    );
    expect(gateway.get('same-wire-custom-endpoint')?.protocol).toBeUndefined();
    expect(gateway.has('placeholder-override')).toBe(false);
    expect(gateway.has('bedrock-override')).toBe(false);

    const anthropic = byId(
      modelsDevProviderModels('anthropic', {
        id: 'anthropic',
        npm: '@ai-sdk/anthropic',
        models: {
          'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', limit: { context: 200000 } },
          'claude-fable-5': { id: 'claude-fable-5', limit: { context: 200000 } },
          'claude-latest': { id: 'claude-latest', limit: { context: 200000 } },
          'kimi-k3': {
            id: 'kimi-k3',
            limit: { context: 262144 },
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
          'glm-5': { id: 'glm-5', limit: { context: 128000 } },
        },
      }),
    );
    expect(anthropic.get('claude-sonnet-4-5')?.supportEfforts).toBeUndefined();
    const fable = anthropic.get('claude-fable-5');
    expect(fable?.supportEfforts).toBeUndefined();
    expect(fable?.alwaysThinking).toBeUndefined();
    expect(anthropic.get('claude-latest')?.supportEfforts).toBeUndefined();
    const kimi = anthropic.get('kimi-k3');
    expect(kimi?.supportEfforts).toEqual(['low', 'high']);
    expect(kimi?.alwaysThinking).toBeUndefined();
    const glm = anthropic.get('glm-5');
    expect(glm?.supportEfforts).toBeUndefined();
    expect(glm?.capability.thinking).toBe(false);
  });
});

describe('providerCatalog', () => {
  it('adds, refreshes in one batch, removes, and persists through the store', async () => {
    const store = createMemoryProviderCatalogStore();
    await store.save({
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
    const stubProvider = (id: string, protocols: Provider['protocols']): Provider => ({
      id,
      protocols,
      listModels: async () => {
        addPulls += 1;
        return [];
      },
      resolveModel: () => {
        throw new Error('unused');
      },
      createRequester: () => {
        throw new Error('unused');
      },
    });

    const imported = modelsDevProviderModels('openai', {
      id: 'openai',
      npm: '@ai-sdk/openai',
      models: {
        'gpt-5': {
          id: 'gpt-5',
          limit: { context: 400000, input: 272000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      },
    });
    catalog.upsert({
      provider: stubProvider('openai', ['openai']),
      info: { customHeaders: { 'x-keep': '2' } },
      models: [
        ...imported.map((model) => ({
          ...model,
          overrides: { maxOutputSize: 64000, displayName: 'GPT-5 Turbo' },
        })),
        {
          provider: 'openai',
          model: 'gpt-5-wire',
          capability: {
            image_in: false,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          maxContextSize: 128000,
          name: 'gpt-5-alias',
          aliases: ['g5w'],
          apiKey: 'sk-test',
          defaultHeaders: { 'x-key': 'v' },
        },
      ],
    });
    catalog.upsert({
      provider: stubProvider('anthropic', ['anthropic']),
      info: { defaultModel: 'claude-sonnet-4-5' },
      models: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(addPulls).toBe(2);
    expect(catalog.providerInfo('openai')?.customHeaders).toEqual({ 'x-keep': '2' });
    const fromAdded = byId(catalog.models('openai')).get('gpt-5');
    expect(fromAdded?.capability.image_in).toBe(true);
    expect(fromAdded?.maxContextSize).toBe(400000);
    expect(fromAdded?.maxInputSize).toBe(272000);
    expect(fromAdded?.maxOutputSize).toBe(64000);
    expect(fromAdded?.displayName).toBe('GPT-5 Turbo');
    expect(fromAdded?.supportEfforts).toEqual(['low', 'high']);

    const asIs = byId(catalog.models('anthropic')).get('claude-sonnet-4-5');
    expect(asIs?.capability.thinking).toBe(false);
    expect(asIs?.supportEfforts).toBeUndefined();

    const withCredentials = byId(catalog.models('openai')).get('gpt-5-wire');
    expect(withCredentials?.name).toBe('gpt-5-alias');
    expect(withCredentials?.apiKey).toBe('sk-test');
    expect(withCredentials?.defaultHeaders).toEqual({ 'x-key': 'v' });
    expect(catalog.models('openai').map((model) => model.model)).toEqual(['gpt-5', 'gpt-5-wire']);
    expect(catalog.models('anthropic').map((model) => model.model)).toEqual(['claude-sonnet-4-5']);
    expect(catalog.providerInfo('anthropic')?.defaultModel).toBe('claude-sonnet-4-5');

    const changes: string[][] = [];
    catalog.onChanged((event) => changes.push([...event.providers]));

    let openaiPulls = 0;
    let googlePulls = 0;
    const provider: Provider = {
      id: 'openai',
      protocols: ['openai'],
      listModels: async () => {
        openaiPulls += 1;
        return [
          {
            provider: 'openai',
            model: 'gpt-5',
            capability: {
              image_in: false,
              video_in: true,
              audio_in: false,
              thinking: true,
              tool_use: true,
            },
            maxContextSize: 100000,
          },
          {
            provider: 'openai',
            model: 'gpt-mini',
            capability: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
            },
            maxContextSize: 32000,
            baseUrl: 'https://seed.test/v1',
          },
        ];
      },
      resolveModel: () => {
        throw new Error('unused');
      },
      createRequester: () => {
        throw new Error('unused');
      },
    };
    const google: Provider = {
      id: 'google',
      protocols: ['google-genai'],
      listModels: async () => {
        googlePulls += 1;
        return [
          {
            provider: 'google',
            model: 'gemini-4',
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
      },
      resolveModel: () => {
        throw new Error('unused');
      },
      createRequester: () => {
        throw new Error('unused');
      },
    };
    catalog.refresh(provider);
    catalog.refresh(provider);
    catalog.refresh(google);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(openaiPulls).toBe(1);
    expect(googlePulls).toBe(1);
    expect(changes).toEqual([['google', 'openai']]);

    const merged = byId(catalog.models('openai')).get('gpt-5');
    expect(merged?.capability.image_in).toBe(true);
    expect(merged?.capability.video_in).toBe(true);
    expect(merged?.capability.thinking).toBe(true);
    expect(merged?.maxContextSize).toBe(400000);
    expect(merged?.supportEfforts).toEqual(['low', 'high']);

    const discoveredOnly = byId(catalog.models('openai')).get('gpt-mini');
    expect(discoveredOnly?.maxContextSize).toBe(32000);
    expect(discoveredOnly?.baseUrl).toBe('https://seed.test/v1');
    expect(byId(catalog.models('google')).get('gemini-4')?.maxContextSize).toBe(1000000);
    expect(byId(catalog.models('openai')).has('no-such-model')).toBe(false);
    expect(catalog.models('openai').map((model) => model.model)).toEqual([
      'gpt-5',
      'gpt-5-wire',
      'gpt-mini',
    ]);
    expect(catalog.providers()).toEqual(['anthropic', 'google', 'openai']);

    const failing: Provider = {
      ...provider,
      listModels: () => Promise.reject(new Error('boom')),
    };
    const failures: ProviderCatalogRefreshFailed[] = [];
    catalog.onRefreshFailed((event) => failures.push(event));
    catalog.refresh(failing);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.providerId).toBe('openai');
    expect((failures[0]?.error as Error).message).toBe('boom');
    expect(byId(catalog.models('openai')).get('gpt-mini')?.maxContextSize).toBe(32000);
    expect(changes).toHaveLength(1);

    catalog.upsert({
      provider: stubProvider('anthropic', ['anthropic']),
      info: { defaultModel: 'claude-fable-5' },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(catalog.models('anthropic')).toEqual([]);
    expect(catalog.providerInfo('anthropic')?.defaultModel).toBe('claude-fable-5');
    expect(changes).toEqual([['google', 'openai'], ['anthropic'], ['anthropic']]);

    catalog.remove('anthropic');
    expect(catalog.providers()).toEqual(['google', 'openai']);
    expect(catalog.models('anthropic')).toEqual([]);
    expect(changes).toEqual([['google', 'openai'], ['anthropic'], ['anthropic'], ['anthropic']]);

    const reopened = await createProviderCatalog({ store });
    expect(reopened.providers()).toEqual(['google', 'openai']);
    expect(reopened.models('openai')).toHaveLength(3);
    expect(byId(reopened.models('openai')).get('gpt-5')?.maxContextSize).toBe(400000);
    expect(byId(reopened.models('google')).get('gemini-4')?.maxContextSize).toBe(1000000);
    expect(reopened.models('anthropic')).toEqual([]);
    expect(reopened.providerInfo('openai')?.customHeaders).toEqual({ 'x-keep': '2' });
    expect(reopened.providerInfo('anthropic')).toBeUndefined();
  });
});
