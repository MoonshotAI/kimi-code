import { describe, expect, it } from 'vitest';

import { clampCompletionTokensForSharedContextWindow } from '#/providers/shared-context-window';

describe('clampCompletionTokensForSharedContextWindow', () => {
  it('lowers an oversized completion cap to fit the remaining shared window', () => {
    const kwargs = clampCompletionTokensForSharedContextWindow({
      model: 'Kimi-K2.6',
      sharedContextWindowTokens: 262144,
      generationKwargs: { max_completion_tokens: 262144 },
      systemPrompt: 'x'.repeat(40_000),
      history: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      tools: [],
    });

    expect(kwargs.max_completion_tokens).toBeLessThan(262144);
    expect(kwargs.max_completion_tokens).toBeGreaterThan(0);
    expect(kwargs.max_tokens).toBeUndefined();
  });

  it('keeps a smaller explicit cap unchanged when it already fits', () => {
    const kwargs = clampCompletionTokensForSharedContextWindow({
      model: 'Kimi-K2.6',
      sharedContextWindowTokens: 262144,
      generationKwargs: { max_completion_tokens: 1024 },
      systemPrompt: 'short prompt',
      history: [],
      tools: [],
    });

    expect(kwargs.max_completion_tokens).toBe(1024);
  });

  it('uses max_tokens for non-Kimi shared-window models', () => {
    const kwargs = clampCompletionTokensForSharedContextWindow({
      model: 'gpt-4o',
      sharedContextWindowTokens: 128000,
      generationKwargs: { max_tokens: 4096 },
      systemPrompt: 'short prompt',
      history: [],
      tools: [],
    });

    expect(kwargs.max_tokens).toBe(4096);
    expect(kwargs.max_completion_tokens).toBeUndefined();
  });
});
