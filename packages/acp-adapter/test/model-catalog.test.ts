import { describe, expect, it } from 'vitest';

import { deriveThinking } from '../src/model-catalog';

describe('deriveThinking', () => {
  it('recognizes declared thinking capabilities, including lone always_thinking', () => {
    expect(
      deriveThinking({
        provider: 'anthropic',
        model: 'claude-fable-5',
        maxContextSize: 1000000,
        capabilities: ['thinking', 'always_thinking'],
      }),
    ).toEqual({ thinkingSupported: true, alwaysThinking: true });

    // `always_thinking` implies `thinking` (kosong ModelCapability contract),
    // so a hand-written declaration without the plain string still counts.
    expect(
      deriveThinking({
        provider: 'custom',
        model: 'custom-model',
        maxContextSize: 262144,
        capabilities: ['always_thinking'],
      }),
    ).toEqual({ thinkingSupported: true, alwaysThinking: true });
  });

  it('detects always-thinking models from kosong knowledge when given the wire type', () => {
    const fable = {
      provider: 'anthropic',
      model: 'claude-fable-5',
      maxContextSize: 1000000,
    };
    // The model name carries no thinking/reason hint and declares nothing —
    // only provider-wire-type detection can classify it.
    expect(deriveThinking(fable, 'anthropic')).toEqual({
      thinkingSupported: true,
      alwaysThinking: true,
    });
    expect(deriveThinking(fable)).toEqual({ thinkingSupported: false });
  });

  it('never marks name-regex or allow-list matches as alwaysThinking', () => {
    // The regex cannot tell an always-on variant from a toggleable one, so
    // these models keep their thinking toggle.
    expect(
      deriveThinking({ provider: 'kimi', model: 'kimi-thinking-preview', maxContextSize: 262144 }),
    ).toEqual({ thinkingSupported: true });
    expect(
      deriveThinking({ provider: 'kimi', model: 'kimi-for-coding', maxContextSize: 262144 }),
    ).toEqual({ thinkingSupported: true });
  });
});
