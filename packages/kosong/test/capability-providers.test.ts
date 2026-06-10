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
  });

  it('unknown Responses model → UNKNOWN_CAPABILITY', () => {
    const cap = make('gpt-mystery').getCapability();
    expect(cap).toEqual(UNKNOWN_CAPABILITY);
  });
});
