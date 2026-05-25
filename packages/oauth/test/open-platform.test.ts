import { describe, expect, it, vi } from 'vitest';

import {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
  removeOpenPlatformConfig,
  type ManagedKimiConfigShape,
} from '../src/open-platform';

function makeModelsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          id: 'kimi-k2-0712-preview',
          context_length: 256000,
          supports_reasoning: true,
          supports_image_in: true,
          supports_video_in: true,
          display_name: 'Kimi K2 0712 Preview',
        },
        {
          id: 'kimi-k2-lite',
          context_length: 128000,
          supports_reasoning: false,
          supports_image_in: false,
          supports_video_in: false,
          supports_tool_use: false,
        },
        {
          id: 'non-kimi-model',
          context_length: 1000,
          supports_reasoning: false,
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('OPEN_PLATFORMS', () => {
  it('contains moonshot.cn and moonshot.ai', () => {
    expect(getOpenPlatformById('moonshot-cn')).toMatchObject({
      name: 'Moonshot AI Open Platform (moonshot.cn)',
      baseUrl: 'https://api.moonshot.cn/v1',
      allowedPrefixes: ['kimi-k'],
    });
    expect(getOpenPlatformById('moonshot-ai')).toMatchObject({
      name: 'Moonshot AI Open Platform (moonshot.ai)',
      baseUrl: 'https://api.moonshot.ai/v1',
      allowedPrefixes: ['kimi-k'],
    });
    expect(getOpenPlatformById('unknown')).toBeUndefined();
  });

  it('isOpenPlatformId works', () => {
    expect(isOpenPlatformId('moonshot-cn')).toBe(true);
    expect(isOpenPlatformId('moonshot-ai')).toBe(true);
    expect(isOpenPlatformId('kimi-code')).toBe(false);
  });
});

describe('fetchOpenPlatformModels', () => {
  it('lists and parses models from the platform endpoint', async () => {
    const fetchMock = vi.fn(async () => makeModelsResponse());
    const platform = getOpenPlatformById('moonshot-cn')!;

    const models = await fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch);

    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'kimi-k2-0712-preview',
      contextLength: 256000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      displayName: 'Kimi K2 0712 Preview',
    });
    expect(models[1]?.supportsToolUse).toBe(false);
    expect(models[2]?.id).toBe('non-kimi-model');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.moonshot.cn/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('surfaces API error messages and status on HTTP error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid API key' } }), { status: 401 }),
    );
    const platform = getOpenPlatformById('moonshot-cn')!;

    const error = await fetchOpenPlatformModels(
      platform,
      'sk-bad',
      fetchMock as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenPlatformApiError);
    expect((error as OpenPlatformApiError).status).toBe(401);
    expect((error as Error).message).toBe('invalid API key');
  });

  it('throws on unexpected response shape', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const platform = getOpenPlatformById('moonshot-cn')!;

    await expect(
      fetchOpenPlatformModels(platform, 'sk-test', fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Unexpected models response/);
  });
});

describe('filterModelsByPrefix', () => {
  it('filters by allowedPrefixes when present', () => {
    const platform = getOpenPlatformById('moonshot-cn')!;
    const models = [
      { id: 'kimi-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
      { id: 'gpt-4', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-kimi-code').ManagedKimiCodeModelInfo[], platform);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('kimi-k2-0712-preview');
  });

  it('returns all models when allowedPrefixes is absent', () => {
    const platform: import('../src/open-platform').OpenPlatformDefinition = {
      id: 'custom',
      name: 'Custom',
      baseUrl: 'https://example.com/v1',
    };
    const models = [
      { id: 'model-a', contextLength: 1000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
      { id: 'model-b', contextLength: 2000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const filtered = filterModelsByPrefix(models as unknown as import('../src/managed-kimi-code').ManagedKimiCodeModelInfo[], platform);
    expect(filtered).toHaveLength(2);
  });
});

describe('capabilitiesForModel', () => {
  it('returns undefined for a model with no capabilities', () => {
    const model = {
      id: 'plain',
      contextLength: 1000,
      supportsReasoning: false,
      supportsImageIn: false,
      supportsVideoIn: false,
      supportsToolUse: false,
    };
    expect(capabilitiesForModel(model)).toBeUndefined();
  });

  it('returns all caps for a full-featured model', () => {
    const model = {
      id: 'full',
      contextLength: 1000,
      supportsReasoning: true,
      supportsImageIn: true,
      supportsVideoIn: true,
      supportsToolUse: true,
    };
    expect(capabilitiesForModel(model)).toEqual(['thinking', 'image_in', 'video_in', 'tool_use']);
  });
});

describe('applyOpenPlatformConfig', () => {
  it('writes provider, models, and defaults', () => {
    const config: ManagedKimiConfigShape = {
      providers: {},
    };
    const platform = getOpenPlatformById('moonshot-cn')!;
    const models = [
      { id: 'kimi-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true, displayName: 'Kimi K2' },
      { id: 'kimi-k2-lite', contextLength: 128000, supportsReasoning: false, supportsImageIn: false, supportsVideoIn: false },
    ];

    const result = applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: true,
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      defaultModel: 'moonshot-cn/kimi-k2-0712-preview',
      defaultThinking: true,
    });

    expect(config.providers['moonshot-cn']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['moonshot-cn/kimi-k2-0712-preview']).toMatchObject({
      provider: 'moonshot-cn',
      model: 'kimi-k2-0712-preview',
      maxContextSize: 256000,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      displayName: 'Kimi K2',
    });
    expect(config.defaultModel).toBe('moonshot-cn/kimi-k2-0712-preview');
    expect(config.defaultThinking).toBe(true);
    expect(config.services).toBeUndefined();
  });

  it('clears stale models for the same provider', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'moonshot-cn': { type: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-old' },
      },
      models: {
        'moonshot-cn/stale': { provider: 'moonshot-cn', model: 'stale', maxContextSize: 1000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
    };
    const platform = getOpenPlatformById('moonshot-cn')!;
    const models = [
      { id: 'kimi-k2-0712-preview', contextLength: 256000, supportsReasoning: true, supportsImageIn: true, supportsVideoIn: true },
    ];

    applyOpenPlatformConfig(config, {
      platform,
      models,
      selectedModel: models[0]!,
      thinking: false,
      apiKey: 'sk-new',
    });

    expect(config.models?.['moonshot-cn/stale']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
  });
});

describe('removeOpenPlatformConfig', () => {
  it('removes provider, its models, and defaultModel when matched', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'moonshot-cn': { type: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-test' },
        'other': { type: 'kimi', baseUrl: 'https://other.test/v1', apiKey: 'sk-other' },
      },
      models: {
        'moonshot-cn/kimi-k2': { provider: 'moonshot-cn', model: 'kimi-k2', maxContextSize: 256000 },
        'other/model': { provider: 'other', model: 'other-model', maxContextSize: 1000 },
      },
      defaultModel: 'moonshot-cn/kimi-k2',
    };

    removeOpenPlatformConfig(config, 'moonshot-cn');

    expect(config.providers['moonshot-cn']).toBeUndefined();
    expect(config.providers['other']).toBeDefined();
    expect(config.models?.['moonshot-cn/kimi-k2']).toBeUndefined();
    expect(config.models?.['other/model']).toBeDefined();
    expect(config.defaultModel).toBeUndefined();
  });

  it('leaves defaultModel intact when it belongs to another provider', () => {
    const config: ManagedKimiConfigShape = {
      providers: {
        'moonshot-cn': { type: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-test' },
      },
      models: {
        'moonshot-cn/kimi-k2': { provider: 'moonshot-cn', model: 'kimi-k2', maxContextSize: 256000 },
      },
      defaultModel: 'other/model',
    };

    removeOpenPlatformConfig(config, 'moonshot-cn');

    expect(config.defaultModel).toBe('other/model');
  });
});
