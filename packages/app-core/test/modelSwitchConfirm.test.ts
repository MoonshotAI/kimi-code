import { describe, expect, it } from 'vitest';

import {
  matchModelSwitchRule,
  parseModelSwitchConfirmConfig,
  resolveModelSwitchHint,
  resolveModelSwitchWarning,
  upstreamModelIdFromConfigModels,
  type ModelSwitchConfirmConfig,
  type ModelSwitchRule,
} from '../src/lib/modelSwitchConfirm';
import {
  matchEffortSwitchRule,
  parseEffortSwitchConfig,
  resolveEffortDescription,
  type EffortSwitchConfig,
} from '../src/lib/effortSwitch';

function enabled(...rules: ModelSwitchRule[]): ModelSwitchConfirmConfig {
  return { enable: true, rules };
}

describe('parseModelSwitchConfirmConfig', () => {
  it('parses session types, hints, and warnings', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          {
            from: 'a',
            to: 'b',
            session_type: 'old',
            hint: { en: 'Cache lost.', zh: '缓存失效。' },
            warning: { en: 'Highspeed warning', zh: '高速警告' },
          },
          { from: 'c', to: 'd', session_type: 'new' },
          { from: 'e', to: 'f', session_type: 'all' },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [
        {
          from: 'a',
          to: 'b',
          session_type: 'old',
          hint: { en: 'Cache lost.', zh: '缓存失效。' },
          warning: { en: 'Highspeed warning', zh: '高速警告' },
        },
        { from: 'c', to: 'd', session_type: 'new' },
        { from: 'e', to: 'f', session_type: 'all' },
      ],
    });
  });

  it('drops invalid rules and keeps the valid ones', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b', session_type: 'invalid' },
          { from: 'a', session_type: 'old' },
          { to: 'b', session_type: 'old' },
          { from: 1, to: 'b', session_type: 'old' },
          'not-an-object',
          { from: 'c', to: 'd', session_type: 'old', hint: 42 },
          { from: 'e', to: 'f', session_type: 'old', warning: { en: 7 } },
          { from: 'g', to: 'h', session_type: 'old', hint: { zh: '仅中文' } },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [{ from: 'g', to: 'h', session_type: 'old', hint: { en: undefined, zh: '仅中文' } }],
    });
  });

  it('keeps id lists and drops rules with empty or mixed lists', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: true,
        rules: [
          { from: ['a', 'b'], to: 'c', session_type: 'old' },
          { from: 'd', to: ['e', 'f'], session_type: 'old' },
          { from: [], to: 'g', session_type: 'old' },
          { from: ['a', 1], to: 'c', session_type: 'old' },
          { from: 'h', to: [1], session_type: 'old' },
        ],
      }),
    ).toEqual({
      enable: true,
      rules: [
        { from: ['a', 'b'], to: 'c', session_type: 'old' },
        { from: 'd', to: ['e', 'f'], session_type: 'old' },
      ],
    });
  });

  it('falls back to disabled when enable is invalid or missing', () => {
    expect(
      parseModelSwitchConfirmConfig({
        enable: 'yes',
        rules: [{ from: 'a', to: 'b', session_type: 'old' }],
      }),
    ).toEqual({ enable: false, rules: [{ from: 'a', to: 'b', session_type: 'old' }] });
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
    expect(matchModelSwitchRule(undefined, 'a', 'b', 'old')).toBeUndefined();
    expect(
      matchModelSwitchRule(
        { enable: false, rules: [{ from: 'a', to: 'b', session_type: 'old' }] },
        'a',
        'b',
        'old',
      ),
    ).toBeUndefined();
  });

  it('matches exact ids and id lists', () => {
    const listed = enabled({ from: ['a', 'b'], to: ['c', 'd'], session_type: 'old', hint: { en: 'listed' } });
    expect(matchModelSwitchRule(listed, 'a', 'c', 'old')?.hint?.en).toBe('listed');
    expect(matchModelSwitchRule(listed, 'b', 'd', 'old')).toBeDefined();
    expect(matchModelSwitchRule(listed, 'x', 'c', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(listed, 'a', 'x', 'old')).toBeUndefined();
  });

  it('matches old, new, and all only in their intended contexts', () => {
    const oldRule: ModelSwitchRule = { from: 'a', to: 'b', session_type: 'old' };
    const newRule: ModelSwitchRule = { from: 'a', to: 'b', session_type: 'new' };
    const allRule: ModelSwitchRule = { from: 'a', to: 'b', session_type: 'all' };

    expect(matchModelSwitchRule(enabled(oldRule), 'a', 'b', 'old')).toBe(oldRule);
    expect(matchModelSwitchRule(enabled(oldRule), 'a', 'b', 'new')).toBeUndefined();
    expect(matchModelSwitchRule(enabled(newRule), 'a', 'b', 'new')).toBe(newRule);
    expect(matchModelSwitchRule(enabled(newRule), 'a', 'b', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(enabled(allRule), 'a', 'b', 'old')).toBe(allRule);
    expect(matchModelSwitchRule(enabled(allRule), 'a', 'b', 'new')).toBe(allRule);
  });

  it('supports independent from and to wildcards, including both together', () => {
    const fromWildcard = enabled({ from: '*', to: 'b', session_type: 'old' });
    const toWildcard = enabled({ from: 'a', to: '*', session_type: 'old' });
    const bothWildcard = enabled({ from: '*', to: '*', session_type: 'all' });

    expect(matchModelSwitchRule(fromWildcard, 'anything', 'b', 'old')).toBeDefined();
    expect(matchModelSwitchRule(fromWildcard, 'anything', 'other', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(toWildcard, 'a', 'anything', 'old')).toBeDefined();
    expect(matchModelSwitchRule(toWildcard, 'other', 'anything', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(bothWildcard, 'anything', 'anything', 'new')).toBeDefined();
  });

  it('does not treat stars inside id arrays as wildcards', () => {
    const config = enabled(
      { from: ['*'], to: 'b', session_type: 'old' },
      { from: 'a', to: ['*'], session_type: 'old' },
    );
    expect(matchModelSwitchRule(config, 'a', 'b', 'old')).toBeUndefined();
  });

  it('uses only the first matching rule without merging text fields', () => {
    const first: ModelSwitchRule = { from: '*', to: '*', session_type: 'old', hint: { en: 'first hint' } };
    const second: ModelSwitchRule = {
      from: 'a',
      to: 'b',
      session_type: 'old',
      hint: { en: 'second hint' },
      warning: { en: 'second warning' },
    };

    expect(matchModelSwitchRule(enabled(first, second), 'a', 'b', 'old')).toBe(first);
    expect(matchModelSwitchRule(enabled(second, first), 'a', 'b', 'old')).toBe(second);
  });
});

describe('model switch localized text', () => {
  const rule: ModelSwitchRule = {
    from: 'a',
    to: 'b',
    session_type: 'old',
    hint: { en: 'Cache lost.', zh: '缓存失效。' },
    warning: { en: 'Highspeed warning', zh: '高速警告' },
  };

  it('reads zh with en fallback and reads en directly', () => {
    expect(resolveModelSwitchHint(rule, 'zh')).toBe('缓存失效。');
    expect(resolveModelSwitchHint(rule, 'en')).toBe('Cache lost.');
    expect(resolveModelSwitchWarning(rule, 'zh')).toBe('高速警告');
    expect(resolveModelSwitchWarning(rule, 'en')).toBe('Highspeed warning');
    expect(resolveModelSwitchHint({ from: 'a', to: 'b', session_type: 'old', hint: { en: 'Cache lost.' } }, 'zh')).toBe(
      'Cache lost.',
    );
  });

  it('returns undefined for missing text or a missing locale arm', () => {
    expect(resolveModelSwitchHint(undefined, 'en')).toBeUndefined();
    expect(resolveModelSwitchWarning(undefined, 'en')).toBeUndefined();
    expect(resolveModelSwitchHint({ from: 'a', to: 'b', session_type: 'old' }, 'en')).toBeUndefined();
    expect(resolveModelSwitchWarning({ from: 'a', to: 'b', session_type: 'old' }, 'en')).toBeUndefined();
    expect(
      resolveModelSwitchHint({ from: 'a', to: 'b', session_type: 'old', hint: { zh: '仅中文' } }, 'en'),
    ).toBeUndefined();
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


describe('effortSwitch', () => {
  const config: EffortSwitchConfig = {
    descriptions: {
      enable: true,
      items: {
        low: { en: 'Light reasoning.', zh: '轻量思考。' },
        high: { en: 'Deeper reasoning.', zh: '深入思考。' },
        max: { en: 'Maximum reasoning.', zh: '最大思考强度。' },
      },
    },
    confirm: {
      enable: true,
      rules: [
        {
          from: 'low',
          to: 'high',
          session_type: 'old',
          hint: { en: 'Switch effort?', zh: '切换思考强度？' },
          warning: { en: 'Cache may be lost.', zh: '缓存可能失效。' },
        },
      ],
    },
  };

  it('parses descriptions and confirm rules independently', () => {
    expect(parseEffortSwitchConfig(config)).toEqual(config);
    expect(
      parseEffortSwitchConfig({
        descriptions: { enable: false, items: { low: { en: 'Light reasoning.' }, high: { en: 42 } } },
        confirm: config.confirm,
      }).descriptions,
    ).toEqual({ enable: false, items: { low: { en: 'Light reasoning.' } } });
  });

  it('resolves localized descriptions and honors the independent enable flag', () => {
    expect(resolveEffortDescription(config, 'low', 'zh')).toBe('轻量思考。');
    expect(resolveEffortDescription(config, 'high', 'en')).toBe('Deeper reasoning.');
    expect(resolveEffortDescription(config, 'off', 'en')).toBeUndefined();
    expect(
      resolveEffortDescription({ confirm: config.confirm } as unknown as EffortSwitchConfig, 'low', 'en'),
    ).toBeUndefined();
    expect(
      resolveEffortDescription(
        { descriptions: { enable: false, items: config.descriptions.items }, confirm: config.confirm },
        'low',
        'zh',
      ),
    ).toBeUndefined();
  });

  it('matches effort rules using shared wildcard and session semantics', () => {
    expect(matchEffortSwitchRule(config, 'low', 'high', 'old')).toEqual(config.confirm.rules[0]);
    expect(matchEffortSwitchRule(config, 'low', 'high', 'new')).toBeUndefined();
    const wildcard = parseEffortSwitchConfig({
      descriptions: { enable: false, items: {} },
      confirm: { enable: true, rules: [{ from: '*', to: '*', session_type: 'all' }] },
    });
    expect(matchEffortSwitchRule(wildcard, 'high', 'max', 'new')).toBeDefined();
  });
});
