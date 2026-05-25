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

  it('falls back to openai for unknown / invalid type', () => {
    expect(inferWireType({ id: 'some-proxy' })).toBe('openai');
    expect(inferWireType({ id: 'x', type: 'not-a-wire' })).toBe('openai');
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
