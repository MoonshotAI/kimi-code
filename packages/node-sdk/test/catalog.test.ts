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
    const result = await fetchCatalog('https://x/api.json', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual(catalog);
  });

  it('throws CatalogFetchError on HTTP error', async () => {
    const fetchMock = vi.fn(async () => catalogResponse('no', 500));
    await expect(
      fetchCatalog('https://x', { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(CatalogFetchError);
  });

  it('throws on a non-object payload', async () => {
    const fetchMock = vi.fn(async () => catalogResponse([1, 2]));
    await expect(
      fetchCatalog('https://x', { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/Unexpected catalog response/);
  });

  it('sends the given User-Agent, and none by default', async () => {
    const fetchMock = vi.fn(async () => catalogResponse({}));

    await fetchCatalog(
      'https://x/api.json',
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        userAgent: 'kimi-code-cli/1.2.3',
      },
    );
    const withUa = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const withUaHeaders = withUa[1].headers as Record<string, string>;
    expect(withUaHeaders['User-Agent']).toBe('kimi-code-cli/1.2.3');
    expect(withUaHeaders['Accept']).toBe('application/json');

    fetchMock.mockClear();
    await fetchCatalog('https://x/api.json', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const withoutUa = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((withoutUa[1].headers as Record<string, string>)['User-Agent']).toBeUndefined();
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
    expect(config.thinking?.enabled).toBe(true);
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

  it('writes declared effort levels from reasoning_options into the model alias', () => {
    // The models.dev `kimi-for-coding` provider shape for `k3`.
    const models = catalogProviderModels({
      id: 'kimi-for-coding',
      models: {
        k3: {
          id: 'k3',
          name: 'Kimi K3',
          limit: { context: 1048576, output: 131072 },
          reasoning: true,
          reasoning_options: [
            { type: 'toggle' },
            { type: 'effort', values: ['low', 'high', 'max'] },
          ],
          tool_call: true,
          modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        },
      },
    });
    const config = { providers: {} } as KimiConfig;

    applyCatalogProvider(config, {
      providerId: 'kimi-for-coding',
      wire: 'anthropic',
      baseUrl: 'https://api.kimi.com/coding',
      apiKey: 'sk',
      models,
      selectedModelId: 'k3',
      thinking: true,
    });

    expect(config.models?.['kimi-for-coding/k3']).toMatchObject({
      provider: 'kimi-for-coding',
      model: 'k3',
      capabilities: ['image_in', 'video_in', 'thinking', 'tool_use'],
      supportEfforts: ['low', 'high', 'max'],
    });
  });

  it('writes per-model protocol/baseUrl overrides and the input-limited context size', () => {
    // The zenmux gateway shape: provider defaults to the OpenAI wire, one
    // model is served over Anthropic on its own endpoint; plus a gpt-5-style
    // input cap below the total context window.
    const models = catalogProviderModels({
      id: 'gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example.test/api/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          name: 'Gateway Claude',
          limit: { context: 200000 },
          provider: {
            npm: '@ai-sdk/anthropic',
            api: 'https://gateway.example.test/api/anthropic/v1',
          },
        },
        'vendor/gpt-model': {
          id: 'vendor/gpt-model',
          limit: { context: 400000, input: 272000, output: 128000 },
        },
      },
    });
    const config = { providers: {} } as KimiConfig;

    applyCatalogProvider(config, {
      providerId: 'gateway',
      wire: 'openai',
      baseUrl: 'https://gateway.example.test/api/v1',
      apiKey: 'sk',
      models,
      selectedModelId: 'vendor/claude-model',
      thinking: false,
    });

    expect(config.models?.['gateway/vendor/claude-model']).toMatchObject({
      provider: 'gateway',
      model: 'vendor/claude-model',
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example.test/api/anthropic',
    });
    const plain = config.models?.['gateway/vendor/gpt-model'];
    expect(plain).toMatchObject({ maxContextSize: 400000, maxInputSize: 272000 });
    expect(plain?.protocol).toBeUndefined();
    expect(plain?.baseUrl).toBeUndefined();
  });

  it('maps always-thinking models to always_thinking and carries the off encoding', () => {
    const models = catalogProviderModels({
      id: 'gateway',
      models: {
        'gpt-5': {
          id: 'gpt-5',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          limit: { context: 400000, input: 272000 },
        },
        'grok-4': {
          id: 'grok-4',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
          limit: { context: 256000 },
        },
      },
    });
    const config = { providers: {} } as KimiConfig;

    applyCatalogProvider(config, {
      providerId: 'gateway',
      wire: 'openai',
      baseUrl: 'https://gateway.example.test/v1',
      apiKey: 'sk',
      models,
      selectedModelId: 'gpt-5',
      thinking: true,
    });

    // No off option: thinking is locked on for a model that always reasons.
    expect(config.models?.['gateway/gpt-5']).toMatchObject({
      capabilities: ['thinking', 'tool_use'].map((c) => (c === 'thinking' ? 'always_thinking' : c)),
      supportEfforts: ['low', 'medium', 'high'],
    });
    expect(config.models?.['gateway/gpt-5']?.capabilities).not.toContain('thinking');
    expect(config.models?.['gateway/gpt-5']?.offEffort).toBeUndefined();

    // 'none' becomes the off encoding; the level list stays selectable-only.
    expect(config.models?.['gateway/grok-4']).toMatchObject({
      capabilities: ['thinking', 'tool_use'],
      supportEfforts: ['low', 'medium', 'high'],
      offEffort: 'none',
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
