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
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['max', { enabled: true, effort: 'max' }],
  ] as const)('maps %s → %o without model efforts', (effort, expected) => {
    expect(thinkingEffortToConfig(effort)).toEqual(expected);
  });

  it.each([
    // With no declared default effort, the historical rule applies: the
    // model's highest declared level (last support_efforts entry) is
    // session-only; anything below it persists as the global default.
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    ['max', { enabled: true }],
    // Undeclared values persist as-is (the provider validates them).
    ['ultra', { enabled: true, effort: 'ultra' }],
  ] as const)('maps %s → %o for [low, high, max] without a default', (effort, expected) => {
    expect(thinkingEffortToConfig(effort, { supportEfforts: ['low', 'high', 'max'] })).toEqual(
      expected,
    );
  });

  it('treats a single declared level as the top tier', () => {
    expect(thinkingEffortToConfig('max', { supportEfforts: ['max'] })).toEqual({ enabled: true });
  });

  it.each([
    ['low', { enabled: true, effort: 'low' }],
    ['high', { enabled: true, effort: 'high' }],
    // Above the delivered default: session-only.
    ['max', { enabled: true }],
  ] as const)('maps %s → %o for [low, high, max] with default high', (effort, expected) => {
    expect(
      thinkingEffortToConfig(effort, {
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      }),
    ).toEqual(expected);
  });

  it('persists the top tier when the delivered default is the top tier', () => {
    expect(
      thinkingEffortToConfig('max', {
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      }),
    ).toEqual({ enabled: true, effort: 'max' });
  });

  it('keeps a non-top pick above the delivered default session-only', () => {
    expect(
      thinkingEffortToConfig('high', {
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'low',
      }),
    ).toEqual({ enabled: true });
  });

  it('falls back to the top-tier rule when the declared default is not a listed level', () => {
    expect(
      thinkingEffortToConfig('max', {
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'ultra',
      }),
    ).toEqual({ enabled: true });
  });

  it.each([
    ['low', { enabled: true, effort: 'low' }],
    ['medium', { enabled: true, effort: 'medium' }],
    ['high', { enabled: true, effort: 'high' }],
    // Above the effective default: session-only.
    ['xhigh', { enabled: true }],
    ['max', { enabled: true }],
  ] as const)(
    // The shape the Anthropic profile inference hands the gate for the
    // latest Claude models: five tiers with the default resolved to 'high'.
    'maps %s → %o for [low, medium, high, xhigh, max] with default high',
    (effort, expected) => {
      expect(
        thinkingEffortToConfig(effort, {
          supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'high',
        }),
      ).toEqual(expected);
    },
  );
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
