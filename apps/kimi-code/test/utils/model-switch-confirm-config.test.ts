import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  matchModelSwitchRule,
  needsModelSwitchConfirmConfigRefresh,
  peekModelSwitchConfirmConfig,
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
  resolveModelSwitchHint,
  resolveModelSwitchWarning,
  type ModelSwitchConfirmConfig,
  type ModelSwitchRule,
} from '#/utils/model-switch-confirm-config';

const CLOUD_CONFIG = {
  enable: true,
  rules: [
    { session_type: 'old', from: 'kimi-k2.5', to: 'kimi-k2-turbo-preview' },
    { session_type: 'old', from: 'kimi-k2-turbo-preview', to: 'kimi-k2.5' },
  ],
};

const ENVELOPE = { name: 'model_switch_confirm', config: CLOUD_CONFIG };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetModelSwitchConfirmConfigCache();
});

describe('refreshModelSwitchConfirmConfig', () => {
  it('POSTs the model_switch_confirm name, returns the parsed config, and warms peek', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual(CLOUD_CONFIG);
    expect(peekModelSwitchConfirmConfig()).toEqual(CLOUD_CONFIG);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/client_configs'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'model_switch_confirm' }),
      }),
    );
  });

  it('drops invalid rules and keeps the valid ones', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { session_type: 'old', from: 'a', to: 'b' },
            { session_type: 'old', from: 'a' },
            { to: 'b' },
            { session_type: 'old', from: 1, to: 'b' },
            'not-an-object',
            { session_type: 'old', from: 'c', to: 'd', extra: 'ignored' },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({
      enable: true,
      rules: [
        { session_type: 'old', from: 'a', to: 'b' },
        { session_type: 'old', from: 'c', to: 'd' },
      ],
    });
  });

  it('requires a valid session type on every rule', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { from: 'a', to: 'b' },
            { from: 'a', to: 'b', session_type: 'invalid' },
            { from: 'c', to: 'd', session_type: 'new' },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result?.rules).toEqual([{ from: 'c', to: 'd', session_type: 'new' }]);
  });

  it('keeps id lists and drops rules with empty or mixed lists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { session_type: 'old', from: ['a', 'b'], to: 'c' },
            { session_type: 'old', from: 'd', to: ['e', 'f'] },
            { session_type: 'old', from: [], to: 'g' },
            { session_type: 'old', from: ['a', 2], to: 'c' },
            { session_type: 'old', from: 'h', to: [1] },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({
      enable: true,
      rules: [
        { session_type: 'old', from: ['a', 'b'], to: 'c' },
        { session_type: 'old', from: 'd', to: ['e', 'f'] },
      ],
    });
  });

  it('falls back to the disabled default when enable is invalid or missing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: { enable: 'yes', rules: [{ session_type: 'old', from: 'a', to: 'b' }] },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({ enable: false, rules: [{ session_type: 'old', from: 'a', to: 'b' }] });
  });

  it('falls back to the disabled default when the payload is not an object', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'model_switch_confirm', config: 'nope' }));

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({ enable: false, rules: [] });
  });

  it('returns undefined when the envelope name does not match', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'survey_popup', config: CLOUD_CONFIG }));

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toBeUndefined();
    expect(peekModelSwitchConfirmConfig()).toBeUndefined();
  });

  it('returns undefined and clears the memory copy when the fetch fails or the response is not ok', async () => {
    await refreshModelSwitchConfirmConfig({
      fetchImpl: vi.fn(async () => jsonResponse(ENVELOPE)) as typeof fetch,
    });
    expect(peekModelSwitchConfirmConfig()).toEqual(CLOUD_CONFIG);

    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(
      refreshModelSwitchConfirmConfig({ fetchImpl: failing as typeof fetch }),
    ).resolves.toBeUndefined();
    expect(peekModelSwitchConfirmConfig()).toBeUndefined();

    const notOk = vi.fn(async () => jsonResponse('no', 503));
    await expect(
      refreshModelSwitchConfirmConfig({ fetchImpl: notOk as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('always refetches — there is no cache TTL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ENVELOPE));

    await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });
    await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent refreshes', async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(jsonResponse(ENVELOPE));
          };
        }),
    );

    const first = refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });
    const second = refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([CLOUD_CONFIG, CLOUD_CONFIG]);
  });

  it('does not automatically retry a settled empty or failed load', async () => {
    const missing = vi.fn(async () => jsonResponse({ name: 'survey_popup', config: CLOUD_CONFIG }));
    expect(needsModelSwitchConfirmConfigRefresh()).toBe(true);
    await refreshModelSwitchConfirmConfig({ fetchImpl: missing as typeof fetch });
    expect(needsModelSwitchConfirmConfigRefresh()).toBe(false);

    resetModelSwitchConfirmConfigCache();
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    await refreshModelSwitchConfirmConfig({ fetchImpl: failing as typeof fetch });
    expect(needsModelSwitchConfirmConfigRefresh()).toBe(false);
  });

  it('separates auth contexts and prevents an older request from replacing newer rules', async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = refreshModelSwitchConfirmConfig({ accessToken: 'old-token', fetchImpl: fetchImpl as typeof fetch });
    const second = refreshModelSwitchConfirmConfig({ accessToken: 'new-token', fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    resolvers[1]!(jsonResponse(ENVELOPE));
    await second;
    resolvers[0]!(jsonResponse({ name: 'model_switch_confirm', config: { enable: false, rules: [] } }));
    await first;

    expect(peekModelSwitchConfirmConfig()).toEqual(CLOUD_CONFIG);
  });
});

describe('rule text parsing', () => {
  it('parses localized hint and warning', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            {
              session_type: 'old',
              from: 'a',
              to: 'b',
              hint: { en: 'Cache lost.', zh: '缓存失效。' },
              warning: { en: 'Highspeed warning', zh: '高速警告' },
            },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result?.rules).toEqual([
      {
        session_type: 'old',
        from: 'a',
        to: 'b',
        hint: { en: 'Cache lost.', zh: '缓存失效。' },
        warning: { en: 'Highspeed warning', zh: '高速警告' },
      },
    ]);
  });

  it('drops rules with malformed hint or warning', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { session_type: 'old', from: 'a', to: 'b', hint: 42 },
            { session_type: 'old', from: 'c', to: 'd', hint: { en: 7 } },
            { session_type: 'old', from: 'e', to: 'f', warning: 42 },
            { session_type: 'old', from: 'g', to: 'h', warning: { zh: 7 } },
            { session_type: 'old', from: 'i', to: 'j' },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result?.rules).toEqual([{ session_type: 'old', from: 'i', to: 'j' }]);
  });
});

function enabled(...rules: ModelSwitchRule[]): ModelSwitchConfirmConfig {
  return { enable: true, rules };
}

describe('matchModelSwitchRule', () => {
  it('returns undefined when the config is missing or disabled', () => {
    expect(matchModelSwitchRule(undefined, 'a', 'b', 'old')).toBeUndefined();
    expect(
      matchModelSwitchRule(
        { enable: false, rules: [{ session_type: 'old', from: 'a', to: 'b' }] },
        'a',
        'b',
        'old',
      ),
    ).toBeUndefined();
  });

  it('returns the matched rule only on an exact from/to match', () => {
    const rule: ModelSwitchRule = { session_type: 'old', from: 'a', to: 'b', hint: { zh: '提示' } };
    const config = enabled(rule);
    expect(matchModelSwitchRule(config, 'a', 'b', 'old')).toEqual(rule);
    expect(matchModelSwitchRule(config, 'b', 'a', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'c', 'old')).toBeUndefined();
  });

  it('matches any id in a from/to list', () => {
    const config = enabled({
      session_type: 'old',
      from: ['a', 'b'],
      to: ['c', 'd'],
      hint: { en: 'listed' },
    });
    expect(matchModelSwitchRule(config, 'a', 'c', 'old')?.hint?.en).toBe('listed');
    expect(matchModelSwitchRule(config, 'b', 'd', 'old')?.hint?.en).toBe('listed');
    expect(matchModelSwitchRule(config, 'a', 'd', 'old')).toBeDefined();
    expect(matchModelSwitchRule(config, 'x', 'c', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'x', 'old')).toBeUndefined();
  });

  it('matches old, new, and all session types only in their intended contexts', () => {
    const oldRule: ModelSwitchRule = { session_type: 'old', from: 'a', to: 'b' };
    const newRule: ModelSwitchRule = { session_type: 'new', from: 'a', to: 'b' };
    const allRule: ModelSwitchRule = { session_type: 'all', from: 'a', to: 'b' };

    expect(matchModelSwitchRule(enabled(oldRule), 'a', 'b', 'old')).toBe(oldRule);
    expect(matchModelSwitchRule(enabled(oldRule), 'a', 'b', 'new')).toBeUndefined();
    expect(matchModelSwitchRule(enabled(newRule), 'a', 'b', 'new')).toBe(newRule);
    expect(matchModelSwitchRule(enabled(newRule), 'a', 'b', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(enabled(allRule), 'a', 'b', 'old')).toBe(allRule);
    expect(matchModelSwitchRule(enabled(allRule), 'a', 'b', 'new')).toBe(allRule);
  });

  it('supports independent from and to wildcards, including both together', () => {
    const fromWildcard = enabled({ session_type: 'old', from: '*', to: 'b' });
    const toWildcard = enabled({ session_type: 'old', from: 'a', to: '*' });
    const bothWildcard = enabled({ session_type: 'all', from: '*', to: '*' });

    expect(matchModelSwitchRule(fromWildcard, 'anything', 'b', 'old')).toBeDefined();
    expect(matchModelSwitchRule(fromWildcard, 'anything', 'other', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(toWildcard, 'a', 'anything', 'old')).toBeDefined();
    expect(matchModelSwitchRule(toWildcard, 'other', 'anything', 'old')).toBeUndefined();
    expect(matchModelSwitchRule(bothWildcard, 'anything', 'anything', 'new')).toBeDefined();
  });

  it('does not treat stars inside id arrays as wildcards', () => {
    const config = enabled(
      { session_type: 'old', from: ['*'], to: 'b' },
      { session_type: 'old', from: 'a', to: ['*'] },
    );
    expect(matchModelSwitchRule(config, 'a', 'b', 'old')).toBeUndefined();
  });

  it('uses only the first matching rule without merging text fields', () => {
    const first: ModelSwitchRule = {
      session_type: 'old',
      from: '*',
      to: '*',
      hint: { en: 'first hint' },
    };
    const second: ModelSwitchRule = {
      session_type: 'old',
      from: 'a',
      to: 'b',
      hint: { en: 'second hint' },
      warning: { en: 'second warning' },
    };

    expect(matchModelSwitchRule(enabled(first, second), 'a', 'b', 'old')).toBe(first);
    expect(matchModelSwitchRule(enabled(second, first), 'a', 'b', 'old')).toBe(second);
  });
});

describe('resolveModelSwitchHint', () => {
  const rule: ModelSwitchRule = {
    session_type: 'old',
    from: 'a',
    to: 'b',
    hint: { en: 'Cache lost.', zh: '缓存失效。' },
  };

  it('returns undefined when the rule is missing', () => {
    expect(resolveModelSwitchHint(undefined)).toBeUndefined();
  });

  it('always reads the en arm, even when zh is provided', () => {
    expect(resolveModelSwitchHint(rule)).toBe('Cache lost.');
  });

  it('returns undefined when the rule does not override the hint', () => {
    expect(resolveModelSwitchHint({ session_type: 'old', from: 'a', to: 'b' })).toBeUndefined();
    expect(resolveModelSwitchHint({ session_type: 'old', from: 'a', to: 'b', hint: { zh: '仅中文' } })).toBeUndefined();
  });
});

describe('resolveModelSwitchWarning', () => {
  it('reads only the en arm and handles missing warnings', () => {
    const rule: ModelSwitchRule = {
      session_type: 'old',
      from: 'a',
      to: 'b',
      warning: { en: 'Highspeed warning', zh: '高速警告' },
    };
    expect(resolveModelSwitchWarning(rule)).toBe('Highspeed warning');
    expect(resolveModelSwitchWarning({ session_type: 'old', from: 'a', to: 'b' })).toBeUndefined();
    expect(resolveModelSwitchWarning(undefined)).toBeUndefined();
  });
});
