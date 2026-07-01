import { describe, expect, it } from 'vitest';

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  deriveAlwaysThinking,
  deriveDefaultThinkingEffort,
  deriveThinkingSupported,
} from '../src/model-catalog';

function alias(model: string, capabilities?: readonly string[]): ModelAlias {
  return {
    model,
    ...(capabilities !== undefined ? { capabilities } : {}),
  } as unknown as ModelAlias;
}

describe('deriveThinkingSupported', () => {
  it('treats a declared always_thinking capability as thinking-supported', () => {
    expect(deriveThinkingSupported(alias('custom-model', ['always_thinking']))).toBe(true);
  });

  it('keeps the existing thinking-capability and name-heuristic triggers', () => {
    expect(deriveThinkingSupported(alias('custom-model', ['thinking']))).toBe(true);
    expect(deriveThinkingSupported(alias('some-thinking-model'))).toBe(true);
    expect(deriveThinkingSupported(alias('plain-model'))).toBe(false);
  });
});

describe('deriveAlwaysThinking', () => {
  it('reads the declared always_thinking capability', () => {
    expect(deriveAlwaysThinking(alias('custom-model', ['thinking', 'always_thinking']))).toBe(true);
    expect(deriveAlwaysThinking(alias('custom-model', ['thinking']))).toBe(false);
  });

  it('does not infer always-thinking from the model name', () => {
    // Name heuristics keep working for thinkingSupported, but only the
    // server-declared capability may lock the toggle to on.
    expect(deriveAlwaysThinking(alias('some-thinking-model'))).toBe(false);
  });
});

describe('deriveDefaultThinkingEffort', () => {
  it('uses overridden supportEfforts and defaultEffort', () => {
    expect(
      deriveDefaultThinkingEffort({
        ...alias('custom-model', ['thinking']),
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
      }),
    ).toBe('high');
  });
});
