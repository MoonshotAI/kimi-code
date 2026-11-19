import { describe, expect, it } from 'vitest';

import {
  matchModelSwitchRule,
  parseModelSwitchConfirmConfig,
  resolveModelSwitchHint,
  upstreamModelIdFromConfigModels,
  type ModelSwitchRule,
} from '../src/lib/modelSwitchConfirm';

describe('parseModelSwitchConfirmConfig', () => {
  it('parses a full payload', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          { from: 'a', to: 'b', hint: { en: 'Cache lost.', zh: '缓存失效。' } },
          { from: 'c', to: 'd' },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [
        { from: 'a', to: 'b', hint: { en: 'Cache lost.', zh: '缓存失效。' } },
        { from: 'c', to: 'd' },
      ],
    });
  });

  it('drops invalid rules and keeps the valid ones', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          { from: 'a', to: 'b' },
          { from: 'a' },
          { to: 'b' },
          { from: 1, to: 'b' },
          'not-an-object',
          { from: 'c', to: 'd', hint: 42 },
          { from: 'e', to: 'f', hint: { en: 7 } },
          { from: 'g', to: 'h', hint: { zh: '仅中文' } },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [
        { from: 'a', to: 'b' },
        { from: 'g', to: 'h', hint: { en: undefined, zh: '仅中文' } },
      ],
    });
  });

  it('keeps id lists and drops rules with empty or mixed lists', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          { from: ['a', 'b'], to: 'c' },
          { from: 'd', to: ['e', 'f'] },
          { from: [], to: 'g' },
          { from: ['a', 1], to: 'c' },
          { from: 'h', to: [1] },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [
        { from: ['a', 'b'], to: 'c' },
        { from: 'd', to: ['e', 'f'] },
      ],
    });
  });

  it('falls back to disabled when enable is invalid or missing', () => {
    expect(parseModelSwitchConfirmConfig({ enable: 'yes', rules: [{ from: 'a', to: 'b' }] })).toEqual({
      enable: false,
      rules: [{ from: 'a', to: 'b' }],
    });
    expect(parseModelSwitchConfirmConfig({ rules: [] })).toEqual({ enable: false, rules: [] });
  });

  it('falls back to disabled when the payload is not an object', () => {
    expect(parseModelSwitchConfirmConfig('nope')).toEqual({ enable: false, rules: [] });
    expect(parseModelSwitchConfirmConfig(null)).toEqual({ enable: false, rules: [] });
    expect(parseModelSwitchConfirmConfig(undefined)).toEqual({ enable: false, rules: [] });
  });
});

describe('matchModelSwitchRule', () => {
  it('returns undefined when the config is missing or disabled', () => {
    expect(matchModelSwitchRule(undefined, 'a', 'b')).toBeUndefined();
    expect(matchModelSwitchRule({ enable: false, rules: [{ from: 'a', to: 'b' }] }, 'a', 'b')).toBeUndefined();
  });

  it('matches any rule in the array on an exact from/to match', () => {
    const config = {
      enable: true,
      rules: [
        { from: 'x', to: 'y', hint: { en: 'first rule' } },
        { from: 'a', to: 'b', hint: { en: 'second rule' } },
        { from: 'a', to: 'c' },
      ],
    };
    expect(matchModelSwitchRule(config, 'a', 'b')?.hint?.en).toBe('second rule');
    expect(matchModelSwitchRule(config, 'a', 'c')).toEqual({ from: 'a', to: 'c' });
    expect(matchModelSwitchRule(config, 'x', 'y')?.hint?.en).toBe('first rule');
    expect(matchModelSwitchRule(config, 'b', 'a')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'a')).toBeUndefined();
  });

  it('matches any id in a from/to list', () => {
    const config = {
      enable: true,
      rules: [{ from: ['a', 'b'], to: ['c', 'd'], hint: { en: 'listed' } }],
    };
    expect(matchModelSwitchRule(config, 'a', 'c')?.hint?.en).toBe('listed');
    expect(matchModelSwitchRule(config, 'b', 'd')?.hint?.en).toBe('listed');
    expect(matchModelSwitchRule(config, 'a', 'd')).toBeDefined();
    expect(matchModelSwitchRule(config, 'x', 'c')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'x')).toBeUndefined();
  });
});

describe('resolveModelSwitchHint', () => {
  const rule: ModelSwitchRule = {
    from: 'a',
    to: 'b',
    hint: { en: 'Cache lost.', zh: '缓存失效。' },
  };

  it('reads the zh arm for the zh locale, falling back to en', () => {
    expect(resolveModelSwitchHint(rule, 'zh')).toBe('缓存失效。');
    expect(resolveModelSwitchHint({ from: 'a', to: 'b', hint: { en: 'Cache lost.' } }, 'zh')).toBe(
      'Cache lost.',
    );
  });

  it('reads the en arm for the en locale', () => {
    expect(resolveModelSwitchHint(rule, 'en')).toBe('Cache lost.');
  });

  it('returns undefined when the rule carries no hint', () => {
    expect(resolveModelSwitchHint(undefined, 'en')).toBeUndefined();
    expect(resolveModelSwitchHint({ from: 'a', to: 'b' }, 'en')).toBeUndefined();
    expect(resolveModelSwitchHint({ from: 'a', to: 'b', hint: { zh: '仅中文' } }, 'en')).toBeUndefined();
  });
});

describe('upstreamModelIdFromConfigModels', () => {
  const models = {
    'kimi-code/k3': { provider: 'kimi-code', model: 'k3' },
    'kimi-code/k3-256k': { provider: 'kimi-code', model: 'k3-256k' },
    'free-tokens_kimi/kimi-k3': { provider: 'free-tokens_kimi', model: 'kimi-k3' },
  };

  it('resolves the upstream model id from the alias definition', () => {
    expect(upstreamModelIdFromConfigModels(models, 'kimi-code/k3')).toBe('k3');
    expect(upstreamModelIdFromConfigModels(models, 'kimi-code/k3-256k')).toBe('k3-256k');
    expect(upstreamModelIdFromConfigModels(models, 'free-tokens_kimi/kimi-k3')).toBe('kimi-k3');
  });

  it('returns undefined for unknown aliases and malformed entries', () => {
    expect(upstreamModelIdFromConfigModels(models, 'kimi-code/k2')).toBeUndefined();
    expect(upstreamModelIdFromConfigModels(undefined, 'kimi-code/k3')).toBeUndefined();
    expect(upstreamModelIdFromConfigModels({ a: 'junk', b: {}, c: { model: 1 } }, 'a')).toBeUndefined();
    expect(upstreamModelIdFromConfigModels({ a: 'junk', b: {}, c: { model: 1 } }, 'b')).toBeUndefined();
    expect(upstreamModelIdFromConfigModels({ a: 'junk', b: {}, c: { model: 1 } }, 'c')).toBeUndefined();
  });
});
