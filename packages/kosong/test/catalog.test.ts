import { describe, expect, it } from 'vitest';

import {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
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
});
