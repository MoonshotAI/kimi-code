import { describe, expect, it } from 'vitest';

import {
  isThinkingOn,
  thinkingEffortFromConfig,
  thinkingEffortToConfig,
} from '@/tui/utils/thinking-config';

describe('thinkingEffortToConfig', () => {
  it.each([
    ['off', { enabled: false }],
    // Only the boolean `enabled` flag is persisted — selecting a model or
    // thinking mode in the TUI no longer records the concrete effort.
    ['on', { enabled: true }],
    ['low', { enabled: true }],
    ['high', { enabled: true }],
    ['max', { enabled: true }],
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
