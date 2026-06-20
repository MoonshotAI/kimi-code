import { describe, expect, it } from 'vitest';

import { clampCompletionTokensForSharedContextWindow } from '#/providers/shared-context-window';

describe('clampCompletionTokensForSharedContextWindow', () => {
  it('lowers an oversized completion cap to fit the remaining shared window', () => {
    const kwargs = clampCompletionTokensForSharedContextWindow({
      model: 'Kimi-K2.6',
      sharedContextWindowTokens: 262144,
      generationKwargs: { max_tokens: 262144 },
      systemPrompt: 'x'.repeat(40_000),
      history: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      tools: [],
    });

    expect(kwargs.max_tokens).toBeLessThan(262144);
    expect(kwargs.max_tokens).toBeGreaterThan(0);
  });

  it('keeps a smaller explicit cap unchanged when it already fits', () => {
    const kwargs = clampCompletionTokensForSharedContextWindow({
      model: 'Kimi-K2.6',
      sharedContextWindowTokens: 262144,
      generationKwargs: { max_tokens: 1024 },
      systemPrompt: 'short prompt',
      history: [],
      tools: [],
    });

    expect(kwargs.max_tokens).toBe(1024);
  });
});
