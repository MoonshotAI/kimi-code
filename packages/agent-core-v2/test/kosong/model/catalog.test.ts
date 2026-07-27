/**
 * `kosong/model` ModelCatalog tests — Model assembly, caching, and
 * config-event invalidation, exercised through the real DI graph (real
 * model/provider services + the real protocol-adapter registry with
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
 *    model/provider change events — and ONLY there: a registry write
 *    that bypasses the events keeps serving the stale Model until
 *    `notifyConfigChanged()` (the load-bearing test-harness contract).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScopedTestHost } from '#/_base/di/test';
import { isErrorCode } from '#/_base/errors/codes';
import { isError2 } from '#/_base/errors/errors';
import { IConfigService } from '#/app/config/config';
import { ConfigErrors } from '#/app/config/errors';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ChatProvider } from '#/kosong/contract/provider';
import { emptyUsage } from '#/kosong/contract/usage';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import '#/kosong/provider/bases/anthropic/index';
import '#/kosong/provider/bases/google-genai/index';
import '#/kosong/provider/bases/openai/index';
import '#/kosong/provider/protocolAdapterRegistry';
import '#/kosong/provider/providers/kimi/kimi.contrib';
import '#/kosong/provider/providers/standard.contrib';
import {
  IProviderService,
  type ProviderConfig,
  type ProvidersSection,
} from '#/kosong/provider/provider';
import '#/kosong/provider/providerService';
import {
  globalDefaultForProvider,
  IModelCatalog,
  type Model,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from '#/kosong/model/catalog';
import { ModelCatalog } from '#/kosong/model/catalogService';
import '#/kosong/model/errors';
import { HostRequestHeaders, IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService, type ModelRecord, type ModelsSection } from '#/kosong/model/model';
import '#/kosong/model/modelService';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';

import { StubConfigService, stubModelOAuthTokens, stubTokenProvider } from '../stubs';

const HOST_HEADERS = { 'User-Agent': 'kimi-test/1.0', 'X-Msh-Device-Id': 'device-1' };

function createHost(
  sections: Record<string, unknown> = {},
  oauthTokens: IModelOAuthTokens = stubModelOAuthTokens(),
): {
  host: ReturnType<typeof createScopedTestHost>;
  config: StubConfigService;
  catalog: ModelCatalog;
  models: IModelService;
  providers: IProviderService;
} {
  const config = new StubConfigService(sections);
  const host = createScopedTestHost([
    [IConfigService, config],
    [IModelOAuthTokens, oauthTokens],
    [IHostRequestHeaders, new HostRequestHeaders(HOST_HEADERS)],
  ]);
  // Kosong's registries are pure in-memory stores now (persistence lives in
  // the app/kosongConfig bridge): seed them from the fixture sections.
  const providers = host.app.accessor.get(IProviderService);
  providers.loadAll(
    (sections['providers'] ?? {}) as ProvidersSection,
    sections['defaultProvider'] as string | undefined,
  );
  const models = host.app.accessor.get(IModelService);
  models.loadAll(
    (sections['models'] ?? {}) as ModelsSection,
    sections['defaultModel'] as string | undefined,
  );
  return {
    host,
    config,
    catalog: host.app.accessor.get(IModelCatalog) as ModelCatalog,
    models,
    providers,
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

/**
 * Mutate the model registry store WITHOUT firing the change events — the
 * silent-write escape hatch for the cache-invalidation tests (replaces the
 * old `StubConfigService.setSilent`, which the in-memory registries can no
 * longer see).
 */
function silentModelWrite(models: IModelService, records: Record<string, ModelRecord>): void {
  (models as unknown as { models: Record<string, ModelRecord> }).models = records;
}

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

  it('passes a declared offEffort through providerOptions for the OpenAI wires', () => {
    const { host, catalog } = createHost({
      providers: {
        gateway: { type: 'openai', apiKey: 'sk-gw', baseUrl: 'https://gateway.example.test/v1' },
        responses: { type: 'openai_responses', apiKey: 'sk-r' },
      },
      models: {
        grok: {
          provider: 'gateway',
          model: 'grok-4',
          maxContextSize: 256000,
          supportEfforts: ['low', 'medium', 'high'],
          offEffort: 'none',
        },
        grokResponses: {
          provider: 'responses',
          model: 'grok-4',
          maxContextSize: 256000,
          offEffort: 'none',
        },
        plain: { provider: 'gateway', model: 'gpt-4.1', maxContextSize: 1000 },
      },
    });
    try {
      expect(catalog.get('grok').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('grokResponses').providerOptions).toEqual({ offEffort: 'none' });
      expect(catalog.get('plain').providerOptions).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('enables google-genai vertex mode through providerOptions when project and location resolve', () => {
    const { host, catalog } = createHost({
      providers: {
        vertex: {
          type: 'google-genai',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
        },
        vertexUrl: {
          type: 'google-genai',
          baseUrl: 'https://us-east4-aiplatform.googleapis.com',
          env: { GOOGLE_CLOUD_PROJECT: 'my-project' },
        },
        plain: { type: 'google-genai', apiKey: 'sk-g' },
      },
      models: {
        v: { provider: 'vertex', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        v2: { provider: 'vertexUrl', model: 'gemini-2.5-flash', maxContextSize: 1000 },
        g: { provider: 'plain', model: 'gemini-2.5-flash', maxContextSize: 1000 },
      },
    });
    try {
      const vertexModel = catalog.get('v');
      expect(vertexModel.protocol).toBe('google-genai');
      expect(vertexModel.providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-central1',
      });
      // The location is also discovered from a vertex-style baseUrl host.
      expect(catalog.get('v2').providerOptions).toEqual({
        vertexai: true,
        project: 'my-project',
        location: 'us-east4',
      });
      // Without both coordinates there is no vertex mode and no options bag.
      expect(catalog.get('g').providerOptions).toBeUndefined();
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
    const { host, catalog } = createHost(
      {
        providers: {
          kimi: { type: 'kimi', oauth: { storage: 'file', key: 'kimi' }, baseUrl: 'https://api.moonshot.ai/v1' },
        },
        models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
      },
      stubModelOAuthTokens(tokenProvider),
    );
    try {
      const model = catalog.get('k1');
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

  it('keeps serving the stale Model on a silent registry write until notifyConfigChanged()', async () => {
    const { host, catalog, models } = createHost(kimiSections);
    try {
      const before = catalog.get('k1');

      // Bypass the change events entirely: the catalog cache is the only
      // stale layer, and only an explicit notify drops it.
      silentModelWrite(models, {
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

describe('ModelCatalog inspect', () => {
  it('builds the god object with per-field provenance (kimi structured model)', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      const view = catalog.inspect('k1');
      expect(view.id).toBe('k1');
      expect(view.provider).toMatchObject({ id: 'kimi', synthesized: false });
      expect(view.provider.definition?.registered).toBe(true);
      expect(view.provider.definition?.baseProtocol).toBe('openai');
      expect(view.resolved.protocol).toBe('openai');
      expect(view.resolved.auth).toEqual({ kind: 'apiKey', apiKey: '••••test' });
      expect(view.sources['resolved.protocol']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.baseUrl']).toMatchObject({ kind: 'config' });
      expect(view.sources['resolved.auth']).toMatchObject({ kind: 'config' });
      expect(view.sources['provider']).toMatchObject({ kind: 'config' });
      expect(view.sources['model']).toMatchObject({ kind: 'config' });
      expect(view.sources['model.id']).toMatchObject({ kind: 'config' });
      expect(view.sources['resolved.capabilities.max_context_tokens']).toMatchObject({
        kind: 'synthesized',
      });
      expect(view.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'none',
      });
      expect(view.sources['resolved']).toMatchObject({ kind: 'synthesized' });
      // Kimi's definition capability is UNKNOWN — nothing is detected.
      expect(view.sources['resolved.capabilities.tool_use']).toMatchObject({ kind: 'none' });
    } finally {
      host.dispose();
    }
  });

  it('serves the same resolution as get (chain consistency, same cache generation)', () => {
    const { host, catalog, models } = createHost(kimiSections);
    try {
      const model = catalog.get('k1');
      const view = catalog.inspect('k1');
      const { authProvider: _auth, id: _id, name, ...rest } = model;
      expect(view.resolved).toMatchObject({ ...rest, wireName: name });

      // A silent registry write keeps the stale generation: inspect reflects
      // THAT generation (what get keeps serving), never a re-resolution.
      silentModelWrite(models, {
        k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 262144, displayName: 'silent' },
      });
      expect(catalog.inspect('k1').resolved.displayName).toBeUndefined();
      expect(catalog.get('k1').displayName).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('attributes profile-filled efforts and capabilities to builtin', () => {
    const { host, catalog } = createHost({
      providers: { claude: { type: 'anthropic', apiKey: 'sk-a' } },
      models: {
        sonnet: { provider: 'claude', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
      },
    });
    try {
      const view = catalog.inspect('sonnet');
      expect(view.resolved.supportEfforts).toEqual(['low', 'medium', 'high']);
      expect(view.sources['model.effective.supportEfforts']).toMatchObject({
        kind: 'builtin',
        detail: expect.stringContaining('anthropic profile'),
      });
      expect(view.sources['model.effective.defaultEffort']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.supportEfforts']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.capabilities.thinking']).toMatchObject({ kind: 'builtin' });
      expect(view.sources['resolved.providerOptions.supportEfforts']).toMatchObject({
        kind: 'builtin',
      });
    } finally {
      host.dispose();
    }
  });

  it('attributes override fields to the overrides block', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' },
      },
      models: {
        m: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 100,
          overrides: { maxContextSize: 200 },
        },
      },
    });
    try {
      const view = catalog.inspect('m');
      expect(view.resolved.maxContextSize).toBe(200);
      expect(view.sources['model.effective.maxContextSize']).toMatchObject({ kind: 'override' });
      expect(view.sources['resolved.maxContextSize']).toMatchObject({ kind: 'override' });
      expect(view.sources['model.effective.model']).toMatchObject({ kind: 'config' });
    } finally {
      host.dispose();
    }
  });

  it('attributes the input cap to config, its clamp, and its absence', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', apiKey: 'sk', baseUrl: 'https://api.example.test/v1' },
      },
      models: {
        declared: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          maxInputSize: 272000,
        },
        clamped: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          maxInputSize: 272000,
          overrides: { maxContextSize: 128000 },
        },
        clampedOverride: {
          provider: 'kimi',
          model: 'kimi-k2',
          maxContextSize: 400000,
          overrides: { maxContextSize: 128000, maxInputSize: 272000 },
        },
        plain: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 100 },
      },
    });
    try {
      const declaredView = catalog.inspect('declared');
      expect(declaredView.resolved.maxInputSize).toBe(272000);
      expect(declaredView.sources['model.effective.maxInputSize']).toMatchObject({ kind: 'config' });
      expect(declaredView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'config',
      });

      const clampedView = catalog.inspect('clamped');
      expect(clampedView.resolved.maxInputSize).toBe(128000);
      expect(clampedView.sources['model.effective.maxInputSize']).toMatchObject({
        kind: 'synthesized',
        detail: expect.stringContaining('clamped'),
      });
      expect(clampedView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'synthesized',
      });

      const clampedOverrideView = catalog.inspect('clampedOverride');
      expect(clampedOverrideView.resolved.maxInputSize).toBe(128000);
      expect(clampedOverrideView.sources['model.effective.maxInputSize']).toMatchObject({
        kind: 'synthesized',
        detail: expect.stringContaining('clamped'),
      });
      expect(clampedOverrideView.sources['model.effective.maxInputSize']).not.toMatchObject({
        kind: 'override',
      });
      expect(clampedOverrideView.sources['resolved.maxInputSize']).toMatchObject({
        kind: 'synthesized',
      });

      const plainView = catalog.inspect('plain');
      expect(plainView.sources['resolved.capabilities.max_input_tokens']).toMatchObject({
        kind: 'none',
      });
    } finally {
      host.dispose();
    }
  });

  it('attributes env-bag credentials and endpoints by env-var name', () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: {
          type: 'kimi',
          env: { KIMI_API_KEY: 'env-token', KIMI_BASE_URL: 'https://kimi-env.example.test/v1' },
        },
      },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 } },
    });
    try {
      const view = catalog.inspect('k1');
      expect(view.resolved.baseUrl).toBe('https://kimi-env.example.test/v1');
      expect(view.resolved.auth.kind).toBe('apiKey');
      expect(view.sources['resolved.auth']).toMatchObject({
        kind: 'env',
        detail: expect.stringContaining('KIMI_API_KEY'),
      });
      expect(view.sources['resolved.baseUrl']).toMatchObject({
        kind: 'env',
        detail: expect.stringContaining('KIMI_BASE_URL'),
      });
      expect(JSON.stringify(view)).not.toContain('env-token');
    } finally {
      host.dispose();
    }
  });

  it('attributes the definition defaultBaseUrl to builtin and reports missing credentials', () => {
    const { host, catalog } = createHost({
      providers: { kimi: { type: 'kimi' } },
      models: { k1: { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1 } },
    });
    try {
      const view = catalog.inspect('k1');
      expect(view.resolved.baseUrl).toBe('https://api.moonshot.ai/v1');
      expect(view.sources['resolved.baseUrl']).toMatchObject({
        kind: 'builtin',
        detail: expect.stringContaining('defaultBaseUrl'),
      });
      expect(view.resolved.auth).toEqual({ kind: 'none' });
      expect(view.sources['resolved.auth']).toMatchObject({ kind: 'none' });
    } finally {
      host.dispose();
    }
  });

  it('marks flat-model providers as synthesized', () => {
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
      const view = catalog.inspect('flat');
      expect(view.provider.synthesized).toBe(true);
      expect(view.provider.id).toBe('flat.example.test');
      expect(view.provider.config).toBeUndefined();
      expect(view.sources['provider']).toMatchObject({ kind: 'synthesized' });
      expect(view.resolved.auth).toEqual({ kind: 'apiKey', apiKey: '••••flat' });
      expect(JSON.stringify(view)).not.toContain('sk-flat');
    } finally {
      host.dispose();
    }
  });

  it('throws config.invalid for unknown models, same as get', () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      expect(() => catalog.inspect('nope')).toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      host.dispose();
    }
  });
});

describe('ModelCatalog ping', () => {
  it('returns the streamed text and usage on a live success', async () => {
    const { host, models, providers } = createHost(kimiSections, stubModelOAuthTokens());
    try {
      const fakeProvider: ChatProvider = {
        name: 'fake-base',
        modelName: 'fake-model',
        thinkingEffort: null,
        async generate() {
          return {
            id: 'msg-1',
            usage: emptyUsage(),
            finishReason: 'completed',
            rawFinishReason: 'stop',
            traceId: null,
            async *[Symbol.asyncIterator]() {
              yield { type: 'text', text: 'pong' };
            },
          };
        },
      };
      const registry = {
        _serviceBrand: undefined,
        supportedProtocols: () => [],
        resolveAdapterIdentity: () => {
          throw new Error('not exercised');
        },
        resolveProviderBaseId: () => {
          throw new Error('not exercised');
        },
        resolveCapability: () => UNKNOWN_CAPABILITY,
        explainCapability: () => ({
          capability: UNKNOWN_CAPABILITY,
          source: { kind: 'none' as const },
        }),
        createChatProvider: () => fakeProvider,
      } as unknown as IProtocolAdapterRegistry;
      const catalog = new ModelCatalog(
        providers,
        models,
        stubModelOAuthTokens(),
        registry,
        new HostRequestHeaders({}),
      );
      const result = await catalog.ping('k1');
      expect(result).toMatchObject({ ok: true, text: 'pong', finishReason: 'completed' });
      expect(result.usage).toEqual(emptyUsage());
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      host.dispose();
    }
  });

  it('returns ok:false with the translated error when the wire fails', async () => {
    const { host, catalog } = createHost({
      models: {
        flat: {
          protocol: 'openai',
          name: 'my-model',
          baseUrl: 'http://127.0.0.1:1/',
          apiKey: 'sk-x',
          maxContextSize: 4096,
        },
      },
    });
    try {
      const result = await catalog.ping('flat');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      host.dispose();
    }
  });

  it('rejects with config.invalid for unknown models', async () => {
    const { host, catalog } = createHost(kimiSections);
    try {
      await expect(catalog.ping('nope')).rejects.toThrowError(
        expect.objectContaining({ code: ConfigErrors.codes.CONFIG_INVALID }),
      );
    } finally {
      host.dispose();
    }
  });
});


/**
 * Enumeration & default-model selection: `listModels` / `listProviders` /
 * `getProvider` project the SAME materialization `get` serves (broken config
 * falls back to the config-only projection so it stays visible), and
 * `setDefaultModel` writes the global default pointer behind a
 * materialization gate.
 */

const catalogSections: Record<string, unknown> = {
  providers: {
    kimi: { type: 'kimi', apiKey: 'sk-test', baseUrl: 'https://api.example.test/v1' },
    openai: { type: 'openai' },
  },
  models: {
    k2: {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    },
    turbo: { provider: 'kimi', model: 'kimi-turbo', maxContextSize: 32768, displayName: 'Kimi Turbo' },
    gpt4o: { provider: 'openai', model: 'gpt-4o', maxContextSize: 128000 },
  },
  defaultModel: 'k2',
};

describe('wire projection (pure)', () => {
  it('toProtocolModel projects the materialized Model into the snake_case wire shape', () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      const record = (catalogSections['models'] as Record<string, ModelRecord>)['k2']!;
      expect(toProtocolModel(catalog.get('k2'), record, 'kimi')).toEqual({
        provider: 'kimi',
        model: 'k2',
        display_name: 'Kimi K2',
        max_context_size: 131072,
        capabilities: ['thinking'],
        support_efforts: undefined,
        default_effort: undefined,
      });
    } finally {
      host.dispose();
    }
  });

  it('toProtocolModelFallback projects the raw record', () => {
    const record: ModelRecord = {
      provider: 'kimi',
      model: 'kimi-k2',
      maxContextSize: 131072,
      displayName: 'Kimi K2',
      capabilities: ['thinking'],
    };
    expect(toProtocolModelFallback('k2', record, 'kimi')).toEqual({
      provider: 'kimi',
      model: 'k2',
      display_name: 'Kimi K2',
      max_context_size: 131072,
      capabilities: ['thinking'],
      support_efforts: undefined,
      default_effort: undefined,
    });
  });

  it('modelIdsForProvider and globalDefaultForProvider group models by provider', () => {
    const models: Record<string, ModelRecord> = {
      a: { provider: 'p1', model: 'm-a' },
      b: { provider: 'p2', model: 'm-b' },
      c: { providerId: 'p1', model: 'm-c' },
    };
    expect(modelIdsForProvider(models, 'p1')).toEqual(['a']);
    expect(globalDefaultForProvider(models, 'a', 'p1')).toBe('a');
    expect(globalDefaultForProvider(models, 'a', 'p2')).toBeUndefined();
    expect(globalDefaultForProvider(models, undefined, 'p1')).toBeUndefined();
  });

  it('toProtocolProvider prefers the provider default, then the global default', () => {
    const models: Record<string, ModelRecord> = { a: { provider: 'p1', model: 'm-a' } };
    const provider: ProviderConfig = { type: 'openai', baseUrl: 'https://x.test/v1' };
    expect(
      toProtocolProvider('p1', provider, models, 'a', { hasApiKey: true, hasOAuthToken: false }),
    ).toEqual({
      id: 'p1',
      type: 'openai',
      base_url: 'https://x.test/v1',
      default_model: 'a',
      has_api_key: true,
      status: 'connected',
      models: ['a'],
    });
    expect(
      toProtocolProvider('p1', { ...provider, defaultModel: 'own' }, models, 'a', {
        hasApiKey: false,
        hasOAuthToken: false,
      }).default_model,
    ).toBe('own');
    expect(
      toProtocolProvider('p1', { ...provider, type: undefined }, models, undefined, {
        hasApiKey: false,
        hasOAuthToken: false,
      }),
    ).toMatchObject({ type: 'openai', status: 'unconfigured', default_model: undefined });
  });
});

describe('ModelCatalog enumeration', () => {
  it('lists configured models as selectable aliases', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listModels()).resolves.toEqual([
        {
          provider: 'kimi',
          model: 'k2',
          display_name: 'Kimi K2',
          max_context_size: 131072,
          capabilities: ['thinking'],
        },
        { provider: 'kimi', model: 'turbo', display_name: 'Kimi Turbo', max_context_size: 32768 },
        { provider: 'openai', model: 'gpt4o', display_name: 'gpt-4o', max_context_size: 128000 },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('projects support_efforts and default_effort from the model config', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        model: 'k2',
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      host.dispose();
    }
  });

  it('projects official Anthropic effort metadata inferred from the model name', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['anthropic'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['opus'] = {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      maxContextSize: 200000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const opus = (await catalog.listModels()).find((model) => model.model === 'opus');
      expect(opus).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('projects latest Opus efforts for unknown Claude-marked Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'custom-claude-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for clearly non-Claude Anthropic-compatible models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['providers'] as Record<string, ProviderConfig>)['custom'] = { type: 'anthropic' };
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'custom',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('projects latest Opus efforts for a flat providerless Claude-marked Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'custom-claude-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({
        capabilities: ['thinking'],
        support_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        default_effort: 'high',
      });
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for a flat providerless non-Claude Anthropic model', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        compatible: {
          model: 'compatible-model',
          baseUrl: 'https://anthropic.example.test',
          protocol: 'anthropic',
          maxContextSize: 128000,
        },
      },
    });
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('does not project fallback efforts for unknown Kimi-managed Anthropic models', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['compatible'] = {
      provider: 'kimi',
      protocol: 'anthropic',
      model: 'compatible-model',
      maxContextSize: 128000,
    };
    const { host, catalog } = createHost(sections);
    try {
      const compatible = (await catalog.listModels()).find((model) => model.model === 'compatible');
      expect(compatible).toMatchObject({ provider: 'kimi', model: 'compatible' });
      expect(compatible?.capabilities).toBeUndefined();
      expect(compatible?.support_efforts).toBeUndefined();
      expect(compatible?.default_effort).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  it('projects effort fields from overrides when present', async () => {
    const sections = structuredClone(catalogSections);
    (sections['models'] as Record<string, ModelRecord>)['k2'] = {
      ...(catalogSections['models'] as Record<string, ModelRecord>)['k2'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      overrides: { supportEfforts: ['low', 'high', 'max'], defaultEffort: 'max' },
    };
    const { host, catalog } = createHost(sections);
    try {
      const [k2] = await catalog.listModels();
      expect(k2).toMatchObject({
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      });
    } finally {
      host.dispose();
    }
  });

  it('falls back to the config projection for models that fail materialization', async () => {
    const { host, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
          maxContextSize: 1000,
          displayName: 'Bad',
        },
      },
    });
    try {
      // Conflicting inline credentials make materialization throw; the
      // listing still shows the broken model with its config values.
      await expect(catalog.listModels()).resolves.toEqual([
        { provider: '', model: 'bad', display_name: 'Bad', max_context_size: 1000 },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('lists providers with per-provider models, default model, and credential state', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.listProviders()).resolves.toEqual([
        {
          id: 'kimi',
          type: 'kimi',
          base_url: 'https://api.example.test/v1',
          default_model: 'k2',
          has_api_key: true,
          status: 'connected',
          models: ['k2', 'turbo'],
        },
        {
          id: 'openai',
          type: 'openai',
          has_api_key: false,
          status: 'unconfigured',
          models: ['gpt4o'],
        },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('detects env-bag credentials through the vendor endpoint declarations', async () => {
    const { host, catalog } = createHost({
      providers: {
        kimi: { type: 'kimi', env: { KIMI_API_KEY: 'kimi-env-key' } },
        claude: { type: 'anthropic', env: { ANTHROPIC_API_KEY: 'anthropic-env-key' } },
        empty: { type: 'openai' },
      },
      models: {},
    });
    try {
      const providers = await catalog.listProviders();
      const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
      expect(byId['kimi']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['claude']).toMatchObject({ has_api_key: true, status: 'connected' });
      expect(byId['empty']).toMatchObject({ has_api_key: false, status: 'unconfigured' });
    } finally {
      host.dispose();
    }
  });

  it('marks an OAuth provider connected when a cached token exists', async () => {
    const { host, catalog } = createHost(
      {
        providers: { acme: { type: 'kimi', oauth: { storage: 'file', key: 'oauth/acme' } } },
        models: {},
      },
      stubModelOAuthTokens(undefined, 'cached-token'),
    );
    try {
      const [provider] = await catalog.listProviders();
      expect(provider).toMatchObject({ id: 'acme', has_api_key: false, status: 'connected' });
    } finally {
      host.dispose();
    }
  });

  it('gets a single provider by id and reports provider.not_found for an unknown one', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.getProvider('kimi')).resolves.toMatchObject({
        id: 'kimi',
        default_model: 'k2',
        models: ['k2', 'turbo'],
      });
      await expect(catalog.getProvider('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'provider.not_found',
      );
      expect(isErrorCode('provider.not_found')).toBe(true);
      expect(isErrorCode('model.not_found')).toBe(true);
    } finally {
      host.dispose();
    }
  });
});

describe('ModelCatalog setDefaultModel', () => {
  it('moves the registry default pointer and returns the wire model', async () => {
    const { host, models, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('turbo')).resolves.toEqual({
        default_model: 'turbo',
        model: {
          provider: 'kimi',
          model: 'turbo',
          display_name: 'Kimi Turbo',
          max_context_size: 32768,
        },
      });
      // The catalog writes the in-memory pointer; persisting it to config is
      // the app/kosongConfig bridge's job.
      expect(models.getDefaultModel()).toBe('turbo');
    } finally {
      host.dispose();
    }
  });

  it('throws model.not_found for an unknown model', async () => {
    const { host, catalog } = createHost(catalogSections);
    try {
      await expect(catalog.setDefaultModel('missing')).rejects.toSatisfy(
        (error) => isError2(error) && error.code === 'model.not_found',
      );
    } finally {
      host.dispose();
    }
  });

  it('rejects a model that fails materialization', async () => {
    const { host, models, catalog } = createHost({
      providers: {},
      models: {
        bad: {
          model: 'bad-model',
          baseUrl: 'https://x.test/v1',
          apiKey: 'sk',
          oauth: { storage: 'file', key: 'oauth/bad' },
        },
      },
    });
    try {
      await expect(catalog.setDefaultModel('bad')).rejects.toThrow();
      expect(models.getDefaultModel()).toBeUndefined();
    } finally {
      host.dispose();
    }
  });
});
