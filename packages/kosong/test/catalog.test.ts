import { describe, expect, it } from 'vitest';

import {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
  type CatalogModelEntry,
} from '../src/catalog';

describe('inferWireType', () => {
  it('honors an explicit valid type', () => {
    expect(inferWireType({ id: 'x', type: 'openai_responses' })).toBe('openai_responses');
  });

  it('infers anthropic from npm or id', () => {
    expect(inferWireType({ id: 'anthropic', npm: '@ai-sdk/anthropic' })).toBe('anthropic');
    expect(inferWireType({ id: 'my-claude' })).toBe('anthropic');
  });

  it('infers google-genai and vertexai', () => {
    expect(inferWireType({ id: 'gemini', npm: '@ai-sdk/google' })).toBe('google-genai');
    expect(inferWireType({ id: 'google-vertex' })).toBe('vertexai');
  });

  it('returns undefined for unknown / invalid wire types', () => {
    expect(inferWireType({ id: 'some-proxy' })).toBeUndefined();
    expect(inferWireType({ id: 'x', type: 'not-a-wire' })).toBeUndefined();
  });
});

describe('catalogBaseUrl', () => {
  it('strips a trailing /v1 for anthropic so the official SDK does not double it', () => {
    expect(catalogBaseUrl({ id: 'k', api: 'https://api.kimi.com/coding/v1' }, 'anthropic')).toBe(
      'https://api.kimi.com/coding',
    );
    expect(catalogBaseUrl({ id: 'k', api: 'https://api.kimi.com/coding/v1/' }, 'anthropic')).toBe(
      'https://api.kimi.com/coding',
    );
  });

  it('leaves anthropic base URLs without a bare /v1 suffix untouched', () => {
    expect(catalogBaseUrl({ id: 'a', api: 'https://api.anthropic.com' }, 'anthropic')).toBe(
      'https://api.anthropic.com',
    );
    expect(catalogBaseUrl({ id: 'a', api: 'https://host/v1beta' }, 'anthropic')).toBe(
      'https://host/v1beta',
    );
  });

  it('passes openai-family base URLs through unchanged (SDK appends /chat/completions)', () => {
    expect(catalogBaseUrl({ id: 'o', api: 'https://api.openai.com/v1' }, 'openai')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('returns undefined for a missing or empty api', () => {
    expect(catalogBaseUrl({ id: 'x' }, 'anthropic')).toBeUndefined();
    expect(catalogBaseUrl({ id: 'x', api: '' }, 'openai')).toBeUndefined();
  });
});

describe('catalogModelToCapability', () => {
  it('maps modalities and limits into a ModelCapability', () => {
    expect(
      catalogModelToCapability({
        id: 'm',
        name: 'M',
        limit: { context: 200000, output: 64000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      }),
    ).toEqual({
      id: 'm',
      name: 'M',
      maxOutputSize: 64000,
      capability: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 200000,
        dynamically_loaded_tools: false,
      },
    });
  });

  it('defaults tool_use to true and skips models without a positive context', () => {
    expect(catalogModelToCapability({ id: 'm', limit: { context: 1000 } })?.capability.tool_use).toBe(
      true,
    );
    expect(catalogModelToCapability({ id: 'm' })).toBeUndefined();
    expect(catalogModelToCapability({ id: 'm', limit: { context: 0 } })).toBeUndefined();
  });

  it('skips embedding and non-text-output models that cannot serve as chat defaults', () => {
    expect(
      catalogModelToCapability({
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        family: 'text-embedding',
        limit: { context: 8192, output: 1536 },
        modalities: { input: ['text'], output: ['text'] },
      }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({
        id: 'grok-imagine-image',
        name: 'Grok Imagine Image',
        family: 'grok',
        limit: { context: 8000 },
        modalities: { input: ['text', 'image'], output: ['image', 'pdf'] },
      }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({
        id: 'mimo-v2-tts',
        name: 'MiMo-V2-TTS',
        family: 'mimo',
        limit: { context: 8192, output: 16384 },
        modalities: { input: ['text'], output: ['audio'] },
      }),
    ).toBeUndefined();
  });

  it.each<[CatalogModelEntry['interleaved'], string | undefined]>([
    [undefined, undefined],
    [true, 'reasoning_content'],
    [false, undefined],
    [{}, undefined],
    [{ field: '' }, undefined],
    [{ field: 'reasoning_content' }, 'reasoning_content'],
    [{ field: 'reasoning_details' }, 'reasoning_details'],
    [{ field: '  reasoning_content  ' }, 'reasoning_content'],
  ])('derives reasoningKey from interleaved=%j → %j', (interleaved, expected) => {
    const model = catalogModelToCapability({ id: 'm', limit: { context: 1000 }, interleaved });
    expect(model?.reasoningKey).toBe(expected);
  });

  it('extracts declared effort levels from reasoning_options', () => {
    // The models.dev `kimi-for-coding`/`k3` shape: toggle plus effort values.
    const model = catalogModelToCapability({
      id: 'k3',
      reasoning: true,
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ],
      limit: { context: 1048576 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'high', 'max']);
    expect(model?.capability.thinking).toBe(true);
  });

  it("drops the 'none' pseudo-effort (the UI already offers 'off')", () => {
    const model = catalogModelToCapability({
      id: 'grok',
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
      limit: { context: 1000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'medium', 'high']);

    const upper = catalogModelToCapability({
      id: 'grok',
      reasoning_options: [{ type: 'effort', values: ['None', 'high'] }],
      limit: { context: 1000 },
    });
    expect(upper?.supportEfforts).toEqual(['high']);
  });

  it('yields no effort list for toggle-only, budget_tokens, or empty reasoning_options', () => {
    for (const reasoning_options of [
      [{ type: 'toggle' }],
      [{ type: 'budget_tokens', min: 1024, max: 32768 }],
      [],
    ] as const) {
      const model = catalogModelToCapability({
        id: 'm',
        reasoning: true,
        reasoning_options,
        limit: { context: 1000 },
      });
      expect(model?.supportEfforts).toBeUndefined();
      expect(model?.capability.thinking).toBe(true);
    }
  });

  it('treats declared effort levels as thinking support when reasoning is absent', () => {
    const model = catalogModelToCapability({
      id: 'm',
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      limit: { context: 1000 },
    });
    expect(model?.supportEfforts).toEqual(['low', 'high']);
    expect(model?.capability.thinking).toBe(true);
  });

  it('prefers limit.input over limit.context for the context budget', () => {
    // The gpt-5 shape on models.dev: 400k window but a 272k input cap.
    expect(
      catalogModelToCapability({ id: 'm', limit: { context: 400000, input: 272000 } })?.capability
        .max_context_tokens,
    ).toBe(272000);
    // A bogus or inconsistent input limit never exceeds the total window.
    expect(
      catalogModelToCapability({ id: 'm', limit: { context: 1000, input: 5000 } })?.capability
        .max_context_tokens,
    ).toBe(1000);
    expect(
      catalogModelToCapability({ id: 'm', limit: { context: 1000, input: 0 } })?.capability
        .max_context_tokens,
    ).toBe(1000);
    expect(
      catalogModelToCapability({ id: 'm', limit: { context: 1000 } })?.capability
        .max_context_tokens,
    ).toBe(1000);
  });

  it('skips deprecated models but keeps beta and alpha ones', () => {
    expect(
      catalogModelToCapability({ id: 'old', status: 'deprecated', limit: { context: 1000 } }),
    ).toBeUndefined();
    expect(
      catalogModelToCapability({ id: 'new', status: 'beta', limit: { context: 1000 } })?.id,
    ).toBe('new');
    expect(
      catalogModelToCapability({ id: 'newer', status: 'alpha', limit: { context: 1000 } })?.id,
    ).toBe('newer');
  });
});

describe('catalogProviderModels', () => {
  it('extracts only valid models from a provider entry', () => {
    const models = catalogProviderModels({
      id: 'p',
      models: {
        good: { id: 'good', limit: { context: 1000 } },
        bad: { id: 'bad' },
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('good');
  });

  it('materializes a per-model Anthropic override with its own endpoint (zenmux shape)', () => {
    const models = catalogProviderModels({
      id: 'zenmux',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://zenmux.example.test/api/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: 'https://zenmux.example.test/api/anthropic/v1' },
        },
        'vendor/plain-model': { id: 'vendor/plain-model', limit: { context: 1000 } },
      },
    });
    expect(models[0]).toMatchObject({
      id: 'vendor/claude-model',
      protocol: 'anthropic',
      baseUrl: 'https://zenmux.example.test/api/anthropic',
    });
    expect(models[1]).toMatchObject({ id: 'vendor/plain-model' });
    expect(models[1]?.protocol).toBeUndefined();
    expect(models[1]?.baseUrl).toBeUndefined();
  });

  it('falls back to the provider api when the override declares only npm (opencode shape)', () => {
    const models = catalogProviderModels({
      id: 'opencode',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.example.test/zen/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic' },
        },
      },
    });
    expect(models[0]).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://opencode.example.test/zen',
    });
  });

  it('skips the override when the provider already speaks Anthropic, the npm is not Anthropic, or the URL is unusable', () => {
    // freemodel shape: provider is Anthropic, model override targets OpenAI —
    // not expressible per-model, left to provider-level resolution.
    const reverse = catalogProviderModels({
      id: 'freemodel',
      npm: '@ai-sdk/anthropic',
      api: 'https://freemodel.example.test/v1',
      models: {
        'vendor/gpt': {
          id: 'vendor/gpt',
          limit: { context: 1000 },
          provider: { npm: '@ai-sdk/openai-compatible' },
        },
      },
    });
    expect(reverse[0]?.protocol).toBeUndefined();

    // google-vertex shape: no api anywhere — the vertex wire keeps applying.
    const noEndpoint = catalogProviderModels({
      id: 'google-vertex',
      npm: '@ai-sdk/google-vertex',
      models: {
        'claude-model': {
          id: 'claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/google-vertex/anthropic' },
        },
      },
    });
    expect(noEndpoint[0]?.protocol).toBeUndefined();

    // Env-placeholder URLs are SDK-side interpolations the config cannot express.
    const placeholder = catalogProviderModels({
      id: 'neon',
      npm: '@ai-sdk/openai-compatible',
      api: '${NEON_BASE_URL}/v1',
      models: {
        'vendor/claude-model': {
          id: 'vendor/claude-model',
          limit: { context: 200000 },
          provider: { npm: '@ai-sdk/anthropic', api: '${NEON_BASE_URL}/anthropic/v1' },
        },
      },
    });
    expect(placeholder[0]?.protocol).toBeUndefined();
  });
});
