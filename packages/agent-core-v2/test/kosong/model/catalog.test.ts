/**
 * `kosong/model` ModelCatalog tests — Model assembly, caching, and
 * config-event invalidation, exercised through the real DI graph (real
 * model/provider/platform services + the real protocol-adapter registry with
 * every base contrib and the kimi + endpoint definitions registered):
 *
 *  - the assembled Model is PURE DATA: no `with*` morphs, no request driver —
 *    per-turn intent belongs to `ModelRequester` params;
 *  - vendor knowledge resolves through the registries: a `kimi` provider
 *    yields `protocol: 'openai'` (the vendor definition's declared base), the
 *    dialect path keeps an explicit foreign protocol, endpoint env fallbacks
 *    come from the definition registry, host-header forwarding follows the
 *    definition's `hostHeaders`, and the Anthropic effort profile is inferred
 *    only for vendors whose thinking is not trait-driven;
 *  - `get`/`getRequester` cache per id; the cache drops on the
 *    model/provider/platform change events — and ONLY there: a config write
 *    that bypasses the events keeps serving the stale Model until
 *    `notifyConfigChanged()` (the load-bearing test-harness contract).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { ConfigErrors } from '#/app/config/errors';
import { IPlatformService } from '#/app/platform/platform';
import '#/app/platform/platformService';
import '#/kosong/provider/bases/anthropic.contrib';
import '#/kosong/provider/bases/google-genai.contrib';
import '#/kosong/provider/bases/openai-responses.contrib';
import '#/kosong/provider/bases/openai.contrib';
import '#/kosong/provider/bases/vertexai.contrib';
import '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import { IProviderService } from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { ModelCatalog } from '#/kosong/model/catalogService';
import { HostRequestHeaders, IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService } from '#/kosong/model/model';
import '#/kosong/model/modelService';

import { StubConfigService, stubOAuthService, stubTokenProvider } from '../stubs';

const HOST_HEADERS = { 'User-Agent': 'kimi-test/1.0', 'X-Msh-Device-Id': 'device-1' };

function createHost(sections: Record<string, unknown> = {}): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  catalog: ModelCatalog;
  models: IModelService;
  providers: IProviderService;
} {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IOAuthService, stubOAuthService()],
    [IHostRequestHeaders, new HostRequestHeaders(HOST_HEADERS)],
  ]);
  return {
    host,
    config,
    catalog: host.app.accessor.get(IModelCatalog) as ModelCatalog,
    models: host.app.accessor.get(IModelService),
    providers: host.app.accessor.get(IProviderService),
  };
}

const kimiSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.moonshot.ai/v1' },
  },
  models: {
    k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144 },
  },
};

let savedCustomHeaders: string | undefined;

beforeEach(() => {
  savedCustomHeaders = process.env['KIMI_CODE_CUSTOM_HEADERS'];
  delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
});

afterEach(() => {
  if (savedCustomHeaders === undefined) delete process.env['KIMI_CODE_CUSTOM_HEADERS'];
  else process.env['KIMI_CODE_CUSTOM_HEADERS'] = savedCustomHeaders;
});

describe('Model assembly (pure data)', () => {
  it('assembles a kimi model: protocol resolves to the vendor base, never a vendor', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(model.id).toBe('k1');
      expect(model.name).toBe('kimi-k2');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('kimi');
      expect(model.providerName).toBe('kimi');
      expect(model.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(model.maxContextSize).toBe(262144);
      expect(model.capabilities.max_context_tokens).toBe(262144);
      // Kimi's definition declares `hostHeaders: 'full'`.
      expect(model.headers).toMatchObject({
        'User-Agent': 'kimi-test/1.0',
        'X-Msh-Device-Id': 'device-1',
      });
    } finally {
      host.dispose();
    }
  });

  it('the Model carries no morphs and no request driver — pure data only', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model: Record<string, unknown> = { ...catalog.get('k1') };
      for (const [key, value] of Object.entries(model)) {
        expect(key.startsWith('with'), `unexpected morph ${key}`).toBe(false);
        expect(typeof value, `field ${key} must be data`).not.toBe('function');
      }
      expect(model['request']).toBeUndefined();
      expect(model['thinkingEffort']).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('forwards only the User-Agent to vendors without a full hostHeaders declaration', () => {
    const { host, catalog } = createHost({
      providers: {
        openai: { type: 'openai', apiKey: 'sk-o', baseUrl: 'https://api.openai.com/v1' },
      },
      models: { gpt: { provider: 'openai', model: 'gpt-5', maxContextSize: 128000 } },
    });
    try {
      const model = catalog.get('gpt');
      expect(model.protocol).toBe('openai');
      expect(model.providerType).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      host.dispose();
    }
  });

  it('keeps an explicit foreign protocol for a kimi model (the dialect path)', () => {
    const { host, catalog } = createHost({
      providers: { kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' } },
      models: {
        k2: { provider: 'kimi', protocol: 'anthropic', model: 'kimi-k2', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('k2');
      expect(model.protocol).toBe('anthropic');
      expect(model.providerType).toBe('kimi');
      // Anthropic base URLs strip the trailing `/v1`.
      expect(model.baseUrl).toBe('https://api.example.test');
      // Kimi thinking is trait-driven: no Anthropic effort profile is inferred.
      expect(model.supportEfforts).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('infers the Anthropic effort profile for non-trait-driven anthropic vendors', () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        sonnet: { provider: 'claude', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
      },
    });
    try {
      const model = catalog.get('sonnet');
      expect(model.protocol).toBe('anthropic');
      expect(model.supportEfforts).toEqual(['low', 'medium', 'high']);
      expect(model.defaultEffort).toBe('high');
      expect(model.capabilities.thinking).toBe(true);
    } finally {
      host.dispose();
    }
  });

  it('resolves provider env-bag credentials and endpoints through the registry', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'env-token', KIMI_BASE_URL: 'https://kimi-env.example.test/v1' } },
        openai: { type: 'openai', env: { OPENAI_API_KEY: 'sk-openai' } },
      },
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 },
        gpt: { provider: 'openai', protocol: 'openai', model: 'gpt-5', maxContextSize: 1000 },
      },
    });
    try {
      const kimi = catalog.get('k1');
      expect(kimi.baseUrl).toBe('https://kimi-env.example.test/v1');
      return expect(kimi.authProvider.getAuth()).resolves.toEqual({ apiKey: 'env-token' });
    } finally {
      host.dispose();
    }
  });

  it('supports flat models with an inline baseUrl (provider synthesized from the origin)', () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'https://flat.example.test/v1',
          apiKey: 'sk-flat',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const model = catalog.get('flat');
      expect(model.providerName).toBe('flat.example.test');
      expect(model.providerType).toBe('openai');
      expect(model.baseUrl).toBe('https://flat.example.test/v1');
    } finally {
      host.dispose();
    }
  });

  it('falls back to defaultProvider when a model names no provider', () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      defaultProvider: 'kimi',
      models: { inherited: { model: 'kimi-k2', maxContextSize: 1000 } },
    });
    try {
      expect(catalog.get('inherited').providerName).toBe('kimi');
    } finally {
      host.dispose();
    }
  });

  it('supports unregistered vendors when the model declares the protocol explicitly', () => {
    const { host, catalog } = createHost({
      providers: {
        mine: { type: 'my-vendor', apiKey: 'sk-m', baseUrl: 'https://vendor.example.test/v1' },
      },
      models: {
        m: { provider: 'mine', protocol: 'openai', model: 'vendor-model', maxContextSize: 1000 },
      },
    });
    try {
      const model = catalog.get('m');
      expect(model.providerType).toBe('my-vendor');
      expect(model.protocol).toBe('openai');
      expect(model.headers).toEqual({ 'User-Agent': 'kimi-test/1.0' });
    } finally {
      host.dispose();
    }
  });

  it('throws config.invalid for unknown models, missing providers, and incomplete records', () => {
    const expectInvalid = (sections: Record<string, unknown>, id: string): void => {
      const { host, catalog } = createHost(sections);
      try {
        expect(() => catalog.get(id)).toThrowError(
          expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
        );
      } finally {
        host.dispose();
      }
    };
    expectInvalid(kimiSections, 'nope');
    expectInvalid({ models: { ghost: { provider: 'missing', model: 'm', maxContextSize: 1 } } }, 'ghost');
    // Flat model with protocol + baseUrl but no wire-facing name.
    expectInvalid(
      { models: { noname: { protocol: 'openai', baseUrl: 'https://x.test', maxContextSize: 1 } } },
      'noname',
    );
    // Structured kimi model without maxContextSize.
    expectInvalid(
      { ...kimiSections, models: { noctx: { provider: 'kimi', model: 'm' } } },
      'noctx',
    );
  });

  it('findByName matches name, model, and aliases', () => {
    const { host, catalog } = createHost({
      ...kimiSections,
      models: {
        k1: { provider: 'kimi', model: 'kimi-k2', aliases: ['k2-latest'], maxContextSize: 1 },
        k2: { provider: 'kimi', name: 'shared-name', maxContextSize: 1 },
        k3: { provider: 'kimi', model: 'shared-name', maxContextSize: 1 },
      },
    });
    try {
      expect(catalog.findByName('kimi-k2')).toEqual(['k1']);
      expect(catalog.findByName('k2-latest')).toEqual(['k1']);
      expect(catalog.findByName('shared-name')).toEqual(['k2', 'k3']);
      expect(catalog.findByName('unknown')).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it('builds a refreshable OAuth auth provider for oauth-backed models', async () => {
    const tokenProvider = stubTokenProvider(['tok-1']);
    const config = new StubConfigService({
      providers: {
        kimi: { type: 'kimi', oauth: { storage: 'file', key: 'kimi' }, baseUrl: 'https://api.moonshot.ai/v1' },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    const host = createScopedTestHost([
      [IConfigService, config],
      [IOAuthService, stubOAuthService(tokenProvider)],
      [IHostRequestHeaders, new HostRequestHeaders({})],
    ]);
    try {
      const model = (host.app.accessor.get(IModelCatalog) as ModelCatalog).get('k1');
      expect(model.authProvider.canRefresh).toBe(true);
      await expect(model.authProvider.getAuth()).resolves.toEqual({ apiKey: 'tok-1' });
    } finally {
      host.dispose();
    }
  });
});

describe('ModelCatalog caching and config-event invalidation', () => {
  it('caches per id; getRequester returns the cached pair', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      expect(catalog.get('k1')).toBe(model);
      const requester = catalog.getRequester('k1');
      expect(catalog.getRequester('k1')).toBe(requester);
      expect(requester.model).toBe(model);
    } finally {
      host.dispose();
    }
  });

  it('drops the cache when a watched config section changes', async () => {
    const { host, catalog, models, providers } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');
      await models.set('k1', { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'K2' });
      const after = catalog.get('k1');
      expect(after).not.toBe(before);
      expect(after.displayName).toBe('K2');

      await providers.set('kimi', { type: 'kimi', apiKey: 'sk-2', baseUrl: 'https://other.example.test/v1' });
      expect(catalog.get('k1').baseUrl).toBe('https://other.example.test/v1');
    } finally {
      host.dispose();
    }
  });

  it('keeps serving the stale Model on a silent config write until notifyConfigChanged()', async () => {
    const { host, catalog, config } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');

      // Bypass the change events entirely: the catalog cache is the only
      // stale layer, and only an explicit notify drops it.
      config.setSilent('models', {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'silent' },
      });
      expect(catalog.get('k1')).toBe(before);

      catalog.notifyConfigChanged();
      const after = catalog.get('k1');
      expect(after).not.toBe(before);
      expect(after.displayName).toBe('silent');
    } finally {
      host.dispose();
    }
  });
});

describe('headers merge order', () => {
  it('lets provider customHeaders win over the host layer', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: {
          type: 'kimi',
          apiKey: 'sk',
          baseUrl: 'https://api.moonshot.ai/v1',
          customHeaders: { 'User-Agent': 'custom-ua', 'X-Custom': 'c' },
        },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    try {
      const model: Model = catalog.get('k1');
      expect(model.headers).toEqual({
        'User-Agent': 'custom-ua',
        'X-Msh-Device-Id': 'device-1',
        'X-Custom': 'c',
      });
    } finally {
      host.dispose();
    }
  });
});
