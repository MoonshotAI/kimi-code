import type { KimiConfig } from '@moonshot-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  applyCatalogProvider,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  fetchCatalog,
  type CatalogModel,
} from '../src/catalog';

function catalogResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const model: CatalogModel = {
  id: 'm1',
  name: 'M1',
  maxOutputSize: 64000,
  capability: {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: 200000,
  },
};

describe('fetchCatalog', () => {
  it('fetches and returns the catalog map', async () => {
    const catalog = { anthropic: { id: 'anthropic', models: { x: { id: 'x', limit: { context: 1000 } } } } };
    const fetchMock = vi.fn(async () => catalogResponse(catalog));
    const result = await fetchCatalog('https://x/api.json', undefined, fetchMock as unknown as typeof fetch);
    expect(result).toEqual(catalog);
  });

  it('throws CatalogFetchError on HTTP error', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('no', 500));
    await expect(
      fetchCatalog('https://x', undefined, fetchMock as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(CatalogFetchError);
  });

  it('throws on a non-object payload', async () => {
    const fetchMock = vi.fn(async () => catalogResponse([1, 2]));
    await expect(
      fetchCatalog('https://x', undefined, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Unexpected catalog response/);
  });
});

describe('catalogModelToAlias', () => {
  it('flattens a catalog model capability into alias fields', () => {
    expect(catalogModelToAlias('anthropic', model)).toEqual({
      provider: 'anthropic',
      model: 'm1',
      maxContextSize: 200000,
      maxOutputSize: 64000,
      capabilities: ['image_in', 'thinking', 'tool_use'],
      displayName: 'M1',
    });
  });
});

describe('applyCatalogProvider', () => {
  it('writes provider, model aliases, and defaults', () => {
    const config = { providers: {} } as KimiConfig;
    const result = applyCatalogProvider(config, {
      providerId: 'anthropic',
      wire: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk',
      models: [model],
      selectedModelId: 'm1',
      thinking: true,
    });

    expect(result.defaultModel).toBe('anthropic/m1');
    expect(config.providers['anthropic']).toMatchObject({ type: 'anthropic', apiKey: 'sk' });
    expect(config.models?.['anthropic/m1']).toMatchObject({
      provider: 'anthropic',
      model: 'm1',
      maxContextSize: 200000,
    });
    expect(config.defaultModel).toBe('anthropic/m1');
    expect(config.defaultThinking).toBe(true);
  });

  it('writes interleaved reasoning key from a catalog-selected model alias', () => {
    const models = catalogProviderModels({
      id: 'deepseek',
      models: {
        'deepseek-v4-pro': {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          family: 'deepseek-thinking',
          limit: { context: 1000000, output: 384000 },
          reasoning: true,
          tool_call: true,
          interleaved: { field: 'reasoning_content' },
        },
      },
    });
    const config = { providers: {} } as KimiConfig;

    applyCatalogProvider(config, {
      providerId: 'deepseek',
      wire: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk',
      models,
      selectedModelId: 'deepseek-v4-pro',
      thinking: true,
    });

    expect(config.models?.['deepseek/deepseek-v4-pro']).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningKey: 'reasoning_content',
    });
  });

  it('clears stale aliases for the same provider but keeps others', () => {
    const config = {
      providers: { anthropic: { type: 'anthropic', apiKey: 'old' } },
      models: {
        'anthropic/stale': { provider: 'anthropic', model: 'stale', maxContextSize: 1 },
        'other/keep': { provider: 'other', model: 'keep', maxContextSize: 1 },
      },
    } as unknown as KimiConfig;

    applyCatalogProvider(config, {
      providerId: 'anthropic',
      wire: 'anthropic',
      apiKey: 'new',
      models: [model],
      selectedModelId: 'm1',
      thinking: false,
    });

    expect(config.models?.['anthropic/stale']).toBeUndefined();
    expect(config.models?.['other/keep']).toBeDefined();
  });
});
