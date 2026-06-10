import { describe, expect, it } from 'vitest';

import { deriveThinkingSupported } from '../src/model-catalog';

describe('deriveThinkingSupported', () => {
  it('recognizes declared thinking capabilities, including lone always_thinking', () => {
    expect(
      deriveThinkingSupported({
        provider: 'anthropic',
        model: 'claude-fable-5',
        maxContextSize: 1000000,
        capabilities: ['thinking', 'always_thinking'],
      }),
    ).toBe(true);

    // `always_thinking` implies `thinking` (kosong ModelCapability contract),
    // so a hand-written declaration without the plain string still counts.
    expect(
      deriveThinkingSupported({
        provider: 'kimi',
        model: 'kimi-x2',
        maxContextSize: 262144,
        capabilities: ['always_thinking'],
      }),
    ).toBe(true);
  });

  it('detects always-thinking models from kosong knowledge when given the wire type', () => {
    const fable = {
      provider: 'anthropic',
      model: 'claude-fable-5',
      maxContextSize: 1000000,
    };
    // The model name carries no thinking/reason hint and declares nothing —
    // only provider-wire-type detection can classify it.
    expect(deriveThinkingSupported(fable, 'anthropic')).toBe(true);
    expect(deriveThinkingSupported(fable)).toBe(false);
  });
});
