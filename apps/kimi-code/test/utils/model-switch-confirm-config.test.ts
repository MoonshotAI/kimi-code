import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  matchModelSwitchRule,
  peekModelSwitchConfirmConfig,
  refreshModelSwitchConfirmConfig,
  resetModelSwitchConfirmConfigCache,
  resolveModelSwitchHint,
  type ModelSwitchRule,
} from '#/utils/model-switch-confirm-config';

const CLOUD_CONFIG = {
  enable: true,
  rules: [
    { from: 'kimi-k2.5', to: 'kimi-k2-turbo-preview' },
    { from: 'kimi-k2-turbo-preview', to: 'kimi-k2.5' },
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
            { from: 'a', to: 'b' },
            { from: 'a' },
            { to: 'b' },
            { from: 1, to: 'b' },
            'not-an-object',
            { from: 'c', to: 'd', extra: 'ignored' },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({
      enable: true,
      rules: [
        { from: 'a', to: 'b' },
        { from: 'c', to: 'd' },
      ],
    });
  });

  it('keeps id lists and drops rules with empty or mixed lists', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { from: ['a', 'b'], to: 'c' },
            { from: 'd', to: ['e', 'f'] },
            { from: [], to: 'g' },
            { from: ['a', 2], to: 'c' },
            { from: 'h', to: [1] },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({
      enable: true,
      rules: [
        { from: ['a', 'b'], to: 'c' },
        { from: 'd', to: ['e', 'f'] },
      ],
    });
  });

  it('falls back to the disabled default when enable is invalid or missing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: { enable: 'yes', rules: [{ from: 'a', to: 'b' }] },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result).toEqual({ enable: false, rules: [{ from: 'a', to: 'b' }] });
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
});

describe('rule hint parsing', () => {
  it('parses a per-rule localized hint', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            {
              from: 'a',
              to: 'b',
              hint: { en: 'Cache lost.', zh: '缓存失效。' },
            },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result?.rules).toEqual([
      {
        from: 'a',
        to: 'b',
        hint: { en: 'Cache lost.', zh: '缓存失效。' },
      },
    ]);
  });

  it('drops a rule whose hint is malformed', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: 'model_switch_confirm',
        config: {
          enable: true,
          rules: [
            { from: 'a', to: 'b', hint: 42 },
            { from: 'c', to: 'd', hint: { en: 7 } },
            { from: 'e', to: 'f' },
          ],
        },
      }),
    );

    const result = await refreshModelSwitchConfirmConfig({ fetchImpl: fetchImpl as typeof fetch });

    expect(result?.rules).toEqual([{ from: 'e', to: 'f' }]);
  });
});

describe('matchModelSwitchRule', () => {
  it('returns undefined when the config is missing or disabled', () => {
    expect(matchModelSwitchRule(undefined, 'a', 'b')).toBeUndefined();
    expect(
      matchModelSwitchRule({ enable: false, rules: [{ from: 'a', to: 'b' }] }, 'a', 'b'),
    ).toBeUndefined();
  });

  it('returns the matched rule only on an exact from/to match', () => {
    const rule = { from: 'a', to: 'b', hint: { zh: '提示' } };
    const config = { enable: true, rules: [rule] };
    expect(matchModelSwitchRule(config, 'a', 'b')).toEqual(rule);
    expect(matchModelSwitchRule(config, 'b', 'a')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'c')).toBeUndefined();
    expect(matchModelSwitchRule(config, 'a', 'a')).toBeUndefined();
  });

  it('matches any rule in the array and carries that rule own hint', () => {
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
    expect(matchModelSwitchRule(config, 'y', 'x')).toBeUndefined();
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

  it('returns undefined when the rule is missing', () => {
    expect(resolveModelSwitchHint(undefined)).toBeUndefined();
  });

  it('always reads the en arm, even when zh is provided', () => {
    expect(resolveModelSwitchHint(rule)).toBe('Cache lost.');
  });

  it('returns undefined when the rule does not override the hint', () => {
    expect(resolveModelSwitchHint({ from: 'a', to: 'b' })).toBeUndefined();
    expect(resolveModelSwitchHint({ from: 'a', to: 'b', hint: { zh: '仅中文' } })).toBeUndefined();
  });
});
