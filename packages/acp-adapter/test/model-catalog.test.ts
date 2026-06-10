import { describe, expect, it } from 'vitest';

import { deriveThinkingSupported } from '../src/model-catalog';

describe('deriveThinkingSupported', () => {
  it('recognizes always-thinking aliases via the thinking string the producers guarantee', () => {
    // Producers (catalog materialization, runtime detection) always spell
    // out 'thinking' alongside 'always_thinking', so the plain membership
    // check keeps working for models like claude-fable-5 whose name carries
    // no thinking/reason hint.
    expect(
      deriveThinkingSupported({
        provider: 'anthropic',
        model: 'claude-fable-5',
        maxContextSize: 1000000,
        capabilities: ['thinking', 'always_thinking'],
      }),
    ).toBe(true);
  });
});
