import { describe, expect, it } from 'vitest';

import { isThinkingOn, thinkingEffortToConfig } from '@/tui/utils/thinking-config';

describe('thinkingEffortToConfig', () => {
  it.each([
    ['off', { enabled: false }],
    // 'on' is the boolean-model on-signal, not a declared effort. It must not
    // be persisted as `thinking.effort` — boolean models have no effort concept
    // and resolve back to 'on' at runtime via defaultThinkingEffortFor.
    ['on', { enabled: true }],
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['max', { enabled: true, effort: 'max' }],
  ] as const)('maps %s → %o', (effort, expected) => {
    expect(thinkingEffortToConfig(effort)).toEqual(expected);
  });
});

describe('isThinkingOn', () => {
  it.each([
    ['off', false],
    ['on', true],
    ['low', true],
    ['high', true],
    ['max', true],
  ] as const)('%s → %s', (effort, expected) => {
    expect(isThinkingOn(effort)).toBe(expected);
  });
});
