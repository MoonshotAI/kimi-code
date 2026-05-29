import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CATALOG_URL,
  loadBuiltInCatalog,
  type CatalogModel,
  type KimiConfig,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATALOG_JSON } from '#/built-in-catalog';
import {
  catalogProviderExistingApiKey,
  catalogModelSelectionInitialState,
  configuredProviderModelCounts,
  resolveConnectCatalogRequest,
} from '#/tui/utils/connect-catalog';

import { builtInCatalogDefine } from '../../../scripts/built-in-catalog.mjs';

describe('resolveConnectCatalogRequest', () => {
  it('prefers the built-in catalog by default and keeps online fetch as fallback', () => {
    expect(resolveConnectCatalogRequest('')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: true,
        allowBuiltInFallback: true,
      },
    });
  });

  it('forces an online fetch when refresh is requested', () => {
    expect(resolveConnectCatalogRequest('refresh')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: false,
        allowBuiltInFallback: true,
      },
    });
    expect(resolveConnectCatalogRequest('  refresh  ')).toEqual({
      kind: 'ok',
      request: {
        url: DEFAULT_CATALOG_URL,
        preferBuiltIn: false,
        allowBuiltInFallback: true,
      },
    });
  });

  it('treats explicit catalog URLs as authoritative and ignores refresh on them', () => {
    expect(resolveConnectCatalogRequest('https://internal.example/catalog.json')).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
    expect(
      resolveConnectCatalogRequest('refresh https://internal.example/catalog.json'),
    ).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
    expect(
      resolveConnectCatalogRequest('https://internal.example/catalog.json refresh'),
    ).toEqual({
      kind: 'ok',
      request: {
        url: 'https://internal.example/catalog.json',
        preferBuiltIn: false,
        allowBuiltInFallback: false,
      },
    });
  });

  it('rejects unsupported flags', () => {
    const flagMessage = (flag: string) =>
      `Unexpected flag "${flag}". Use /connect [url] [refresh] instead.`;
    expect(resolveConnectCatalogRequest('--refresh')).toEqual({
      kind: 'error',
      message: flagMessage('--refresh'),
    });
    expect(resolveConnectCatalogRequest('--url=https://internal.example/catalog.json')).toEqual({
      kind: 'error',
      message: flagMessage('--url=https://internal.example/catalog.json'),
    });
    expect(resolveConnectCatalogRequest('--url https://internal.example/catalog.json')).toEqual({
      kind: 'error',
      message: flagMessage('--url'),
    });
  });

  it('rejects non-URL bare tokens', () => {
    expect(resolveConnectCatalogRequest('ignored text')).toEqual({
      kind: 'error',
      message: 'Unknown argument "ignored". Usage: /connect [url] [refresh]',
    });
  });

  it('rejects multiple URLs', () => {
    expect(
      resolveConnectCatalogRequest('https://a.com/x.json https://b.com/y.json'),
    ).toEqual({
      kind: 'error',
      message: 'Only one catalog URL can be provided. Got "https://a.com/x.json" and "https://b.com/y.json".',
    });
  });
});

describe('catalogModelSelectionInitialState', () => {
  function model(id: string): CatalogModel {
    return { id, capability: { id, contextWindow: 1000 } } as unknown as CatalogModel;
  }

  function config(over: Partial<KimiConfig>): KimiConfig {
    return { providers: {}, ...over } as KimiConfig;
  }

  const models = [model('large'), model('mini'), model('nano')];

  it('returns empty state when no config models match the provider', () => {
    expect(
      catalogModelSelectionInitialState(
        'acme',
        models,
        config({
          models: { 'other/x': { provider: 'other', model: 'x', maxContextSize: 1 } },
        }),
      ),
    ).toEqual({ selectedAliases: [], defaultAlias: undefined, thinking: undefined });
  });

  it('preselects every alias the config wires to this provider, in config order', () => {
    const result = catalogModelSelectionInitialState(
      'acme',
      models,
      config({
        models: {
          'acme/nano': { provider: 'acme', model: 'nano', maxContextSize: 1 },
          'acme/large': { provider: 'acme', model: 'large', maxContextSize: 1 },
        },
      }),
    );

    expect(result.selectedAliases).toEqual(['acme/nano', 'acme/large']);
    expect(result.defaultAlias).toBeUndefined();
    expect(result.thinking).toBeUndefined();
  });

  it('drops config entries whose model is no longer in the catalog', () => {
    const result = catalogModelSelectionInitialState(
      'acme',
      models,
      config({
        models: {
          'acme/mini': { provider: 'acme', model: 'mini', maxContextSize: 1 },
          'acme/legacy': { provider: 'acme', model: 'legacy', maxContextSize: 1 },
        },
      }),
    );

    expect(result.selectedAliases).toEqual(['acme/mini']);
  });

  it('promotes defaultModel to defaultAlias and carries defaultThinking', () => {
    const result = catalogModelSelectionInitialState(
      'acme',
      models,
      config({
        models: {
          'acme/mini': { provider: 'acme', model: 'mini', maxContextSize: 1 },
          'acme/large': { provider: 'acme', model: 'large', maxContextSize: 1 },
        },
        defaultModel: 'acme/large',
        defaultThinking: true,
      }),
    );

    expect(result.defaultAlias).toBe('acme/large');
    expect(result.thinking).toBe(true);
  });

  it('ignores defaultModel that belongs to another provider', () => {
    const result = catalogModelSelectionInitialState(
      'acme',
      models,
      config({
        models: {
          'acme/mini': { provider: 'acme', model: 'mini', maxContextSize: 1 },
          'other/x': { provider: 'other', model: 'x', maxContextSize: 1 },
        },
        defaultModel: 'other/x',
        defaultThinking: true,
      }),
    );

    expect(result.selectedAliases).toEqual(['acme/mini']);
    expect(result.defaultAlias).toBeUndefined();
    // No default for this provider → don't carry thinking either.
    expect(result.thinking).toBeUndefined();
  });
});

describe('catalogProviderExistingApiKey', () => {
  function config(over: Partial<KimiConfig>): KimiConfig {
    return { providers: {}, ...over } as KimiConfig;
  }

  it('returns a trimmed existing provider apiKey', () => {
    expect(
      catalogProviderExistingApiKey(
        'acme',
        config({ providers: { acme: { type: 'openai', apiKey: ' sk-existing ' } } }),
      ),
    ).toBe('sk-existing');
  });

  it('ignores missing and empty provider apiKey values', () => {
    expect(
      catalogProviderExistingApiKey(
        'acme',
        config({ providers: { acme: { type: 'openai', apiKey: '   ' } } }),
      ),
    ).toBeUndefined();
    expect(
      catalogProviderExistingApiKey(
        'acme',
        config({ providers: { other: { type: 'openai', apiKey: 'sk-other' } } }),
      ),
    ).toBeUndefined();
  });
});

describe('configuredProviderModelCounts', () => {
  function config(over: Partial<KimiConfig>): KimiConfig {
    return { providers: {}, ...over } as KimiConfig;
  }

  it('returns an empty map for an empty config', () => {
    expect(configuredProviderModelCounts(config({}))).toEqual(new Map());
  });

  it('excludes providers that have an entry but no models wired up', () => {
    const counts = configuredProviderModelCounts(
      config({
        providers: { acme: { type: 'openai', apiKey: 'k' } },
        models: {},
      }),
    );
    expect(counts.size).toBe(0);
  });

  it('excludes orphan models whose provider block was hand-deleted', () => {
    const counts = configuredProviderModelCounts(
      config({
        providers: {},
        models: { 'ghost/mini': { provider: 'ghost', model: 'mini', maxContextSize: 1 } },
      }),
    );
    expect(counts.size).toBe(0);
  });

  it('counts models per provider, only when the provider block also exists', () => {
    const counts = configuredProviderModelCounts(
      config({
        providers: {
          acme: { type: 'openai', apiKey: 'a' },
          openai: { type: 'openai', apiKey: 'b' },
        },
        models: {
          'acme/large': { provider: 'acme', model: 'large', maxContextSize: 1 },
          'acme/mini': { provider: 'acme', model: 'mini', maxContextSize: 1 },
          'openai/gpt': { provider: 'openai', model: 'gpt', maxContextSize: 1 },
          'ghost/x': { provider: 'ghost', model: 'x', maxContextSize: 1 },
        },
      }),
    );
    expect(counts.get('acme')).toBe(2);
    expect(counts.get('openai')).toBe(1);
    expect(counts.has('ghost')).toBe(false);
    expect(counts.size).toBe(2);
  });
});

describe('built-in connect catalog injection', () => {
  it('keeps the source placeholder empty so generated catalog data is not committed', () => {
    expect(BUILT_IN_CATALOG_JSON).toBeUndefined();
    expect(loadBuiltInCatalog(BUILT_IN_CATALOG_JSON)).toBeUndefined();
  });

  it('embeds a generated catalog file through the tsdown define value', async () => {
    const catalog = {
      openai: {
        id: 'openai',
        npm: '@ai-sdk/openai',
        models: {
          'gpt-test': {
            id: 'gpt-test',
            limit: { context: 1000, output: 100 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'kimi-built-in-catalog-'));
    try {
      const file = join(dir, 'catalog.json');
      const text = JSON.stringify(catalog);
      await writeFile(file, text, 'utf-8');

      const defineValue = builtInCatalogDefine({ KIMI_CODE_BUILT_IN_CATALOG_FILE: file });
      expect(JSON.parse(defineValue)).toBe(text);
      expect(loadBuiltInCatalog(JSON.parse(defineValue))).toEqual(catalog);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
