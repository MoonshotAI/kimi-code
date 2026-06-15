/**
 * `getModelCapability(wire, model)` table tests.
 *
 * For every wire:
 *   - Known models return the capabilities the table declares for them.
 *   - Unknown models return UNKNOWN_CAPABILITY (no throw) so the capability
 *     gate stays non-fatal when the operator uses a model the table has
 *     not catalogued yet.
 *
 * Assertions stick to individual fields (image_in / video_in / …) rather
 * than matching the whole object so future additions (e.g. new fields in
 * `ModelCapability`) do not churn every row.
 */

import { UNKNOWN_CAPABILITY } from '#/capability';
import { getModelCapability } from '#/providers/index';
import { describe, expect, it } from 'vitest';

describe('getModelCapability: kimi', () => {
  it('does not infer capabilities from Kimi model names', () => {
    for (const model of [
      'kimi-for-coding',
      'kimi-code',
      'kimi-k2-turbo-preview',
      'kimi-k2.5',
      'kimi-thinking-preview',
    ]) {
      expect(getModelCapability('kimi', model)).toEqual(UNKNOWN_CAPABILITY);
    }
  });

  it('unknown Kimi model → UNKNOWN_CAPABILITY (no throw)', () => {
    expect(getModelCapability('kimi', 'some-fake-model')).toEqual(UNKNOWN_CAPABILITY);
  });
});

describe('getModelCapability: google-genai', () => {
  it('gemini-1.5-pro → image_in + video_in + audio_in + tool_use', () => {
    const cap = getModelCapability('google-genai', 'gemini-1.5-pro');
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-1.5-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = getModelCapability('google-genai', 'gemini-1.5-flash');
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gemini-2.0-flash → image_in + video_in + audio_in + tool_use', () => {
    const cap = getModelCapability('google-genai', 'gemini-2.0-flash');
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.audio_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('unknown Gemini model → UNKNOWN_CAPABILITY (no throw)', () => {
    expect(getModelCapability('google-genai', 'gemini-not-real-xyz')).toEqual(UNKNOWN_CAPABILITY);
  });

  it('non-gemini model name → UNKNOWN_CAPABILITY', () => {
    expect(getModelCapability('google-genai', 'claude-3-5-sonnet')).toEqual(UNKNOWN_CAPABILITY);
  });

  it('vertexai wire shares the gemini table', () => {
    const cap = getModelCapability('vertexai', 'gemini-1.5-pro');
    expect(cap.image_in).toBe(true);
    expect(cap.video_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });
});

describe('getModelCapability: anthropic', () => {
  it('claude-3-5-sonnet → image_in + tool_use, audio_in=false', () => {
    const cap = getModelCapability('anthropic', 'claude-3-5-sonnet');
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
  });

  it('claude-3-haiku → image_in + tool_use, audio_in=false, thinking=false', () => {
    // Claude 3 Haiku supports vision (all Claude 3.x share vision support);
    // Anthropic has no audio models; thinking is a Claude 4 feature.
    const cap = getModelCapability('anthropic', 'claude-3-haiku');
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.audio_in).toBe(false);
    expect(cap.thinking).toBe(false);
  });

  it('claude-opus-4 → image_in + thinking + tool_use', () => {
    const cap = getModelCapability('anthropic', 'claude-opus-4');
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('claude-fable-5 → image_in + thinking + tool_use', () => {
    const cap = getModelCapability('anthropic', 'claude-fable-5');
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('no Anthropic model supports audio_in', () => {
    // Sanity: Anthropic has no audio-input models today. If one ships later
    // and this fails, update the table — but make it a conscious decision.
    for (const m of ['claude-3-5-sonnet', 'claude-3-haiku', 'claude-opus-4']) {
      expect(getModelCapability('anthropic', m).audio_in).toBe(false);
    }
  });

  it('unknown Anthropic model → UNKNOWN_CAPABILITY', () => {
    expect(getModelCapability('anthropic', 'claude-not-real')).toEqual(UNKNOWN_CAPABILITY);
  });
});

describe('getModelCapability: openai', () => {
  it('gpt-4o → image_in + tool_use', () => {
    const cap = getModelCapability('openai', 'gpt-4o');
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('gpt-3.5-turbo → image_in=false, tool_use=true', () => {
    const cap = getModelCapability('openai', 'gpt-3.5-turbo');
    expect(cap.image_in).toBe(false);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = getModelCapability('openai', 'o1');
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('unknown OpenAI-legacy model → UNKNOWN_CAPABILITY', () => {
    expect(getModelCapability('openai', 'gpt-mystery')).toEqual(UNKNOWN_CAPABILITY);
  });
});

describe('getModelCapability: openai_responses', () => {
  it('gpt-4.1 → image_in + tool_use (Responses flagship)', () => {
    const cap = getModelCapability('openai_responses', 'gpt-4.1');
    expect(cap.image_in).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o1 → thinking=true, tool_use=true', () => {
    const cap = getModelCapability('openai_responses', 'o1');
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('o3-mini → thinking=true', () => {
    const cap = getModelCapability('openai_responses', 'o3-mini');
    expect(cap.thinking).toBe(true);
  });

  it('unknown Responses model → UNKNOWN_CAPABILITY', () => {
    expect(getModelCapability('openai_responses', 'gpt-mystery')).toEqual(UNKNOWN_CAPABILITY);
  });
});
