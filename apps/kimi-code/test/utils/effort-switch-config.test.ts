import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  matchEffortSwitchRule,
  needsEffortSwitchConfigRefresh,
  peekEffortSwitchConfig,
  refreshEffortSwitchConfig,
  resetEffortSwitchConfigCache,
  resolveEffortDescription,
  type EffortSwitchConfig,
} from '#/utils/effort-switch-config';

const CLOUD_CONFIG: EffortSwitchConfig = {
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

function response(config: unknown): Response {
  return new Response(JSON.stringify({ name: 'effort_switch_confirm', config }));
}

afterEach(() => {
  resetEffortSwitchConfigCache();
});

describe('effort switch config', () => {
  it('parses descriptions and confirm rules independently', async () => {
    await refreshEffortSwitchConfig({ fetchImpl: vi.fn(async () => response(CLOUD_CONFIG)) as typeof fetch });

    expect(peekEffortSwitchConfig()).toEqual(CLOUD_CONFIG);
    expect(resolveEffortDescription(CLOUD_CONFIG, 'low')).toBe('Light reasoning.');
    expect(resolveEffortDescription(CLOUD_CONFIG, 'off')).toBeUndefined();
    expect(
      resolveEffortDescription({ confirm: CLOUD_CONFIG.confirm } as unknown as EffortSwitchConfig, 'low'),
    ).toBeUndefined();
    expect(matchEffortSwitchRule(CLOUD_CONFIG, 'low', 'high', 'old')).toEqual(CLOUD_CONFIG.confirm.rules[0]);
    expect(matchEffortSwitchRule(CLOUD_CONFIG, 'low', 'high', 'new')).toBeUndefined();
  });

  it('keeps valid entries when other descriptions or rules are malformed', async () => {
    await refreshEffortSwitchConfig({
      fetchImpl: vi.fn(async () =>
        response({
          descriptions: {
            enable: false,
            items: {
              low: { en: 'Light reasoning.' },
              high: { en: 42 },
              max: 'not-an-object',
            },
          },
          confirm: {
            enable: true,
            rules: [
              { from: 'low', to: 'high', session_type: 'all' },
              { from: 'low', session_type: 'old' },
              { from: 'high', to: 'max', session_type: 'invalid' },
            ],
          },
        }),
      ) as typeof fetch,
    });

    const config = peekEffortSwitchConfig();
    expect(config?.descriptions).toEqual({ enable: false, items: { low: { en: 'Light reasoning.' } } });
    expect(config?.confirm.rules).toEqual([{ from: 'low', to: 'high', session_type: 'all' }]);
    expect(resolveEffortDescription(config, 'low')).toBeUndefined();
  });

  it('supports independent wildcards and first-match rule order', async () => {
    const config: EffortSwitchConfig = {
      descriptions: { enable: false, items: {} },
      confirm: {
        enable: true,
        rules: [
          { from: '*', to: 'max', session_type: 'all', hint: { en: 'first' } },
          { from: 'low', to: '*', session_type: 'all', hint: { en: 'second' } },
        ],
      },
    };

    expect(matchEffortSwitchRule(config, 'low', 'max', 'new')?.hint?.en).toBe('first');
    expect(matchEffortSwitchRule(config, 'high', 'max', 'old')?.hint?.en).toBe('first');
    expect(matchEffortSwitchRule(config, 'low', 'high', 'old')?.hint?.en).toBe('second');
  });

  it('does not automatically retry a settled empty or failed load', async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ name: 'other', config: null })));
    expect(needsEffortSwitchConfigRefresh()).toBe(true);
    await refreshEffortSwitchConfig({ fetchImpl: missing as typeof fetch });
    expect(needsEffortSwitchConfigRefresh()).toBe(false);

    resetEffortSwitchConfigCache();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await refreshEffortSwitchConfig({ fetchImpl: failing as typeof fetch });
    expect(needsEffortSwitchConfigRefresh()).toBe(false);
  });
});
