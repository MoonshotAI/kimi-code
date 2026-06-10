/**
 * Per-provider `getCapability(model?)` table tests.
 *
 * For every provider:
 *   - Known models return the capabilities the table declares for them.
 *   - Unknown models return UNKNOWN_CAPABILITY (no throw) so the capability
 *     gate stays non-fatal when the operator uses a model the provider has
 *     not catalogued yet.
 *
 * Assertions stick to individual fields (image_in / video_in / …) rather
 * than matching the whole object so future additions (e.g. new fields in
 * `ModelCapability`) do not churn every row.
 */

import { UNKNOWN_CAPABILITY } from '#/capability';
import { AnthropicChatProvider } from '#/providers/anthropic';
import { GoogleGenAIChatProvider } from '#/providers/google-genai';
import { KimiChatProvider } from '#/providers/kimi';
import { OpenAILegacyChatProvider } from '#/providers/openai-legacy';
import { OpenAIResponsesChatProvider } from '#/providers/openai-responses';
import { createProvider, getProviderModelCapability, type ProviderConfig } from '#/providers/index';
import { describe, expect, it } from 'vitest';
describe('KimiChatProvider.getCapability', () => {
  function make(model: string): KimiChatProvider {
    return new KimiChatProvider({ model, apiKey: 'test-key' });
  }

  it('does not infer capabilities from Kimi model names', () => {
    for (const model of [
      'kimi-for-coding',
      'kimi-code',
      'kimi-k2-turbo-preview',
      'kimi-k2.5',
      'kimi-thinking-preview',
    ]) {
      expect(make(model).getCapability()).toEqual(UNKNOWN_CAPABILITY);
    }
  });

  it('explicit model arg overrides this.modelName', () => {
    const provider = make('kimi-k2-turbo-preview');
    expect(provider.getCapability('kimi-for-coding')).toEqual(UNKNOWN_CAPABILITY);
  });

  it('unknown Kimi model → UNKNOWN_CAPABILITY (no throw)', () => {
    const cap = make('some-fake-model').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
describe('GoogleGenAIChatProvider.getCapability', () => {
  function make(model: string): GoogleGenAIChatProvider {
    return new GoogleGenAIChatProvider({ model, apiKey: 'test-key' });
  }

  it('gemini-1.5-pro → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-1.5-pro').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-1.5-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-1.5-flash').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-2.0-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = make('gemini-2.0-flash').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('unknown Gemini model → UNKNOWN_CAPABILITY (no throw)', () => {
    const cap = make('gemini-not-real-xyz').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });

  it('gemini-2.5-pro cannot disable thinking → always_thinking; 2.5-flash stays toggleable', () => {
    // 2.5 Pro enforces a minimum thinking budget (128) and rejects
    // thinking_budget: 0; 2.5 Flash accepts budget 0.
    const pro = make('gemini-2.5-pro').getCapability();
    expect(pro.thinking).toBe(true);
    expect(pro.always_thinking).toBe(true);
    const flash = make('gemini-2.5-flash').getCapability();
    expect(flash.thinking).toBe(true);
    expect(flash.always_thinking).toBeUndefined();
  });

  it('non-gemini model name → UNKNOWN_CAPABILITY', () => {
    const cap = make('claude-3-5-sonnet').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
describe('AnthropicChatProvider.getCapability', () => {
  function make(model: string): AnthropicChatProvider {
    return new AnthropicChatProvider({ model, apiKey: 'test-key', stream: false });
  }

  it('claude-3-5-sonnet → image_in + tool_use, audio_in=false', () => {
    const cap = make('claude-3-5-sonnet').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
  });

  it('claude-3-haiku → image_in + tool_use, audio_in=false, thinking=false', () => {
    // Claude 3 Haiku supports vision (all Claude 3.x share vision support);
    // Anthropic has no audio models; thinking is a Claude 4 feature.
    const cap = make('claude-3-haiku').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
    expect(cap.thinking).toBe(false);
  });

  it('claude-opus-4 → image_in + thinking + tool_use', () => {
    const cap = make('claude-opus-4').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('claude-fable-5 → image_in + thinking + tool_use', () => {
    const cap = make('claude-fable-5').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('claude-fable-5 → always_thinking; toggleable Claude 4 models are not', () => {
    // Fable cannot run with thinking turned off; Opus 4 can.
    expect(make('claude-fable-5').getCapability().always_thinking).toBe(true);
    expect(make('claude-opus-4').getCapability().always_thinking).toBeUndefined();
  });

  it('vendor-prefixed Fable ids detect always_thinking like the wire layer', () => {
    // The capability row is driven by the same isFableModel predicate
    // generate() uses to omit `thinking: disabled`, so every id that runs
    // always-on also advertises it.
    for (const id of [
      'anthropic.claude-fable-5-v1:0',
      'us.anthropic.claude-fable-5-20251101-v1:0',
      'openrouter/anthropic/claude-fable-5',
      'fable-5',
      'claude-fable-latest', // version-less: covered by the prefix branch
    ]) {
      const cap = make(id).getCapability();
      expect(cap.always_thinking, id).toBe(true);
      expect(cap.thinking, id).toBe(true);
    }
  });

  it('ids merely containing the fable substring do not classify as Fable', () => {
    // The isFableModel prefix branch is separator-anchored.
    expect(make('claude-fabled-2').getCapability()).toEqual(UNKNOWN_CAPABILITY);
  });

  it('no Anthropic model supports audio_in', () => {
    // Sanity: Anthropic has no audio-input models today. If one ships later
    // and this fails, update the table — but make it a conscious decision.
    for (const m of ['claude-3-5-sonnet', 'claude-3-haiku', 'claude-opus-4']) {
      expect(make(m).getCapability().audio_in).toBe(false);
    }
  });

  it('unknown Anthropic model → UNKNOWN_CAPABILITY', () => {
    const cap = make('claude-not-real').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
describe('OpenAILegacyChatProvider.getCapability', () => {
  function make(model: string): OpenAILegacyChatProvider {
    return new OpenAILegacyChatProvider({ model, apiKey: 'test-key' });
  }

  it('gpt-4o → image_in + tool_use', () => {
    const cap = make('gpt-4o').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gpt-3.5-turbo → image_in=false, tool_use=true', () => {
    const cap = make('gpt-3.5-turbo').getCapability();
    expect(cap.image_in).toBe(false);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = make('o1').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o-series reasoning cannot be turned off → always_thinking', () => {
    // 'off' omits reasoning_effort and pre-gpt-5.1 reasoning models do not
    // support 'none' — the server still reasons at its default effort.
    expect(make('o3').getCapability().always_thinking).toBe(true);
    expect(make('gpt-4o').getCapability().always_thinking).toBeUndefined();
  });

  it('unknown OpenAI-legacy model → UNKNOWN_CAPABILITY', () => {
    const cap = make('gpt-mystery').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
describe('OpenAIResponsesChatProvider.getCapability', () => {
  function make(model: string): OpenAIResponsesChatProvider {
    return new OpenAIResponsesChatProvider({ model, apiKey: 'test-key' });
  }

  it('gpt-4.1 → image_in + tool_use (Responses flagship)', () => {
    const cap = make('gpt-4.1').getCapability();
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = make('o1').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o3-mini → thinking=true', () => {
    const cap = make('o3-mini').getCapability();
    expect(cap.thinking).toBe(true);
    expect(cap.always_thinking).toBe(true);
  });

  it('unknown Responses model → UNKNOWN_CAPABILITY', () => {
    const cap = make('gpt-mystery').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
describe('getProviderModelCapability (pure lookup)', () => {
  // Cross-check against the instance path: the pure lookup's switch in
  // providers/index.ts and each ChatProvider class's getCapability are two
  // copies of the same type→registry mapping. If a provider's getCapability
  // implementation ever changes (e.g. kimi gains catalog knowledge), this
  // fails instead of the two silently drifting apart.
  const CASES: ReadonlyArray<{ config: ProviderConfig; models: readonly string[] }> = [
    {
      config: { type: 'anthropic', model: 'claude-fable-5', apiKey: 'test-key' },
      models: ['claude-fable-5', 'claude-opus-4', 'claude-3-5-sonnet', 'claude-not-real'],
    },
    {
      config: { type: 'openai', model: 'o3', apiKey: 'test-key' },
      models: ['o3', 'gpt-4o', 'gpt-mystery'],
    },
    {
      config: { type: 'openai_responses', model: 'o3-mini', apiKey: 'test-key' },
      models: ['o3-mini', 'gpt-4.1', 'gpt-mystery'],
    },
    {
      config: { type: 'google-genai', model: 'gemini-2.5-pro', apiKey: 'test-key' },
      models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-not-real'],
    },
    {
      config: { type: 'vertexai', model: 'gemini-2.5-pro', apiKey: 'test-key' },
      models: ['gemini-2.5-pro', 'gemini-not-real'],
    },
    {
      config: { type: 'kimi', model: 'kimi-for-coding', apiKey: 'test-key' },
      models: ['kimi-for-coding', 'kimi-thinking-preview'],
    },
  ];

  it('agrees with ChatProvider.getCapability for every provider type', () => {
    for (const { config, models } of CASES) {
      const provider = createProvider(config);
      for (const model of models) {
        expect(getProviderModelCapability(config.type, model), `${config.type}/${model}`).toEqual(
          provider.getCapability?.(model),
        );
      }
    }
  });
});
