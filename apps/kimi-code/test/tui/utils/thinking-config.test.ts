import { describe, expect, it } from 'vitest';

import {
  isThinkingOn,
  thinkingEffortFromConfig,
  thinkingEffortToConfig,
} from '@/tui/utils/thinking-config';

describe('thinkingEffortToConfig', () => {
  it.each([
    ['off', { enabled: false }],
    // 'on' is the boolean-model on-signal, not a declared effort. It must not
    // be persisted as `thinking.effort` — boolean models have no effort concept
    // and resolve back to 'on' at runtime via defaultThinkingEffortFor.
    ['on', { enabled: true }],
    // Whitelisted levels persist as the global default; 'max' and unknown
    // names are session-only and record only the boolean toggle.
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['xhigh', { enabled: true, effort: 'xhigh' }],
    ['max', { enabled: true }],
    ['ultra', { enabled: true }],
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

describe('thinkingEffortFromConfig', () => {
  it.each([
    [undefined, undefined],
    [{}, undefined],
    // enabled with no concrete effort → let the model's own default apply.
    [{ enabled: true }, undefined],
    [{ enabled: false }, 'off'],
    [{ enabled: true, effort: 'high' }, 'high'],
    // effort is honored even when enabled is not explicitly set.
    [{ effort: 'max' }, 'max'],
  ] as const)('%o → %s', (config, expected) => {
    expect(thinkingEffortFromConfig(config)).toBe(expected);
  });
});
