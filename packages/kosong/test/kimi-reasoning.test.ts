import { describe, expect, it } from 'vitest';

import {
  isKimiReasoningModel,
  kimiThinkingWireParams,
  usesMaxCompletionTokensOnWire,
} from '#/providers/kimi-reasoning';

describe('isKimiReasoningModel', () => {
  it('detects Kimi deployment ids on Foundry', () => {
    expect(isKimiReasoningModel('Kimi-K2.6')).toBe(true);
    expect(isKimiReasoningModel('kimi-k2.5')).toBe(true);
    expect(isKimiReasoningModel('moonshot-v1')).toBe(true);
  });

  it('does not match unrelated models', () => {
    expect(isKimiReasoningModel('gpt-4o')).toBe(false);
    expect(isKimiReasoningModel('deepseek-v3')).toBe(false);
  });
});

describe('usesMaxCompletionTokensOnWire', () => {
  it('uses max_completion_tokens for Kimi and OpenAI reasoning models', () => {
    expect(usesMaxCompletionTokensOnWire('Kimi-K2.6')).toBe(true);
    expect(usesMaxCompletionTokensOnWire('gpt-5')).toBe(true);
    expect(usesMaxCompletionTokensOnWire('o3-mini')).toBe(true);
  });

  it('uses max_tokens for generic chat models', () => {
    expect(usesMaxCompletionTokensOnWire('gpt-4o')).toBe(false);
  });
});

describe('kimiThinkingWireParams', () => {
  it('enables thinking when reasoning is configured', () => {
    expect(
      kimiThinkingWireParams({
        reasoningEffort: 'medium',
        thinkingExplicitlyOff: false,
      }),
    ).toEqual({ type: 'enabled' });
  });

  it('disables thinking when explicitly off', () => {
    expect(
      kimiThinkingWireParams({
        reasoningEffort: 'medium',
        thinkingExplicitlyOff: true,
      }),
    ).toEqual({ type: 'disabled' });
  });
});
