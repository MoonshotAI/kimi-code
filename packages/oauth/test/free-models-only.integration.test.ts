import { describe, it, expect } from 'vitest';
import { refreshProviderCatalog } from '../src/refreshProviderModels';
import type { ManagedKimiConfigShape } from '../src/managed-kimi-code';
import { fetchOpenAIProviderModels } from '../src/openai-compatible';

// ---------------------------------------------------------------------------
// Integration test: verify free_models_only filter with REAL API endpoints.
// These endpoints do NOT require OAuth — just a valid API key in the header.
// ---------------------------------------------------------------------------

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY'] ?? '';
const OPENCODE_BASE = 'https://opencode.ai/zen/v1';
const OPENCODE_KEY = process.env['OPENCODE_API_KEY'] ?? '';
const KILO_BASE = 'https://api.kilo.ai/api/gateway';
const KILO_KEY = process.env['KILO_API_KEY'] ?? '';

const NETWORK_TIMEOUT = 30_000;

const hasOpenRouterKey = OPENROUTER_KEY.length > 0;
const hasOpenCodeKey = OPENCODE_KEY.length > 0;
const hasKiloKey = KILO_KEY.length > 0;

interface RefreshHost {
  getConfig(): Promise<ManagedKimiConfigShape>;
  removeProvider(id: string): Promise<ManagedKimiConfigShape>;
  setConfig(patch: Partial<ManagedKimiConfigShape>): Promise<ManagedKimiConfigShape>;
  resolveOAuthToken(): Promise<string>;
}

function makeHost(initialConfig: ManagedKimiConfigShape): {
  host: RefreshHost;
  getConfig: () => ManagedKimiConfigShape;
} {
  let config = structuredClone(initialConfig);
  return {
    host: {
      getConfig: async () => structuredClone(config),
      removeProvider: async (id) => {
        const next = structuredClone(config);
        delete next.providers[id];
        if (next.models) {
          for (const [key, model] of Object.entries(next.models)) {
            if ((model as { provider?: string }).provider === id) {
              delete next.models[key];
            }
          }
        }
        config = next;
        return structuredClone(config);
      },
      setConfig: async (patch) => {
        config = { ...config, ...patch } as ManagedKimiConfigShape;
        return structuredClone(config);
      },
      resolveOAuthToken: async () => '',
    },
    getConfig: () => config,
  };
}

describe.skipIf(!hasOpenRouterKey && !hasOpenCodeKey && !hasKiloKey)('free_models_only integration — real API endpoints', () => {
  describe('raw fetch + filter', () => {
    it.skipIf(!hasOpenRouterKey)(
      'openrouter: fetches real models and filters to free-only',
      async () => {
        const models = await fetchOpenAIProviderModels(OPENROUTER_BASE, OPENROUTER_KEY, {});
        expect(models.length).toBeGreaterThan(0);

        const freeModels = models.filter((m) => m.id.toLowerCase().includes('free'));
        const paidModels = models.filter((m) => !m.id.toLowerCase().includes('free'));

        console.log(`  openrouter: ${models.length} total, ${freeModels.length} free, ${paidModels.length} paid`);

        expect(freeModels.length).toBeGreaterThan(0);
        expect(paidModels.length).toBeGreaterThan(0);
        for (const m of freeModels) {
          expect(m.id.toLowerCase()).toContain('free');
        }
      },
      NETWORK_TIMEOUT,
    );

    it.skipIf(!hasOpenCodeKey)(
      'opencode: fetches real models and filters to free-only',
      async () => {
        const models = await fetchOpenAIProviderModels(OPENCODE_BASE, OPENCODE_KEY, {});
        expect(models.length).toBeGreaterThan(0);

        const freeModels = models.filter((m) => m.id.toLowerCase().includes('free'));
        const paidModels = models.filter((m) => !m.id.toLowerCase().includes('free'));

        console.log(`  opencode: ${models.length} total, ${freeModels.length} free, ${paidModels.length} paid`);

        expect(freeModels.length).toBeGreaterThan(0);
        expect(paidModels.length).toBeGreaterThan(0);
        for (const m of freeModels) {
          expect(m.id.toLowerCase()).toContain('free');
        }
      },
      NETWORK_TIMEOUT,
    );

    it.skipIf(!hasKiloKey)(
      'kilo: fetches real models and filters to free-only',
      async () => {
        const models = await fetchOpenAIProviderModels(KILO_BASE, KILO_KEY, {});
        expect(models.length).toBeGreaterThan(0);

        const freeModels = models.filter((m) => m.id.toLowerCase().includes('free'));
        const paidModels = models.filter((m) => !m.id.toLowerCase().includes('free'));

        console.log(`  kilo: ${models.length} total, ${freeModels.length} free, ${paidModels.length} paid`);

        expect(freeModels.length).toBeGreaterThan(0);
        expect(paidModels.length).toBeGreaterThan(0);
        for (const m of freeModels) {
          expect(m.id.toLowerCase()).toContain('free');
        }
      },
      NETWORK_TIMEOUT,
    );
  });

  describe('refreshProviderCatalog end-to-end', () => {
    it.skipIf(!hasOpenRouterKey)(
      'openrouter: after catalog refresh with free_models_only, config has ONLY free models',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            openrouter: { type: 'openai', baseUrl: OPENROUTER_BASE, apiKey: OPENROUTER_KEY, free_models_only: true },
          },
          models: {
            'openrouter/some-paid-model': { provider: 'openrouter', model: 'some-paid-model', maxContextSize: 100000 },
            'openrouter/tencent/hy3': { provider: 'openrouter', model: 'tencent/hy3', maxContextSize: 262144 },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        const result = await refreshProviderCatalog(host, {});

        expect(result.failed).toEqual([]);

        const finalConfig = getConfig();
        const openrouterModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'openrouter',
        );

        console.log(`  openrouter final: ${openrouterModels.length} models in config`);
        for (const [alias] of openrouterModels) {
          console.log(`    ${alias}`);
        }

        for (const [alias] of openrouterModels) {
          expect(alias.toLowerCase()).toContain('free');
        }

        expect(finalConfig.models?.['openrouter/some-paid-model']).toBeUndefined();
        expect(finalConfig.models?.['openrouter/tencent/hy3']).toBeUndefined();
        expect(openrouterModels.length).toBeGreaterThan(0);
      },
      NETWORK_TIMEOUT,
    );

    it.skipIf(!hasOpenCodeKey)(
      'opencode: after catalog refresh with free_models_only, config has ONLY free models',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            opencode: { type: 'openai', baseUrl: OPENCODE_BASE, apiKey: OPENCODE_KEY, free_models_only: true },
          },
          models: {
            'opencode/paid-claude-sonnet': { provider: 'opencode', model: 'claude-sonnet-4-5', maxContextSize: 200000 },
            'opencode/paid-gpt-5': { provider: 'opencode', model: 'gpt-5', maxContextSize: 200000 },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        const result = await refreshProviderCatalog(host, {});

        expect(result.failed).toEqual([]);

        const finalConfig = getConfig();
        const opencodeModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'opencode',
        );

        console.log(`  opencode final: ${opencodeModels.length} models in config`);
        for (const [alias] of opencodeModels) {
          console.log(`    ${alias}`);
        }

        for (const [alias] of opencodeModels) {
          expect(alias.toLowerCase()).toContain('free');
        }

        expect(finalConfig.models?.['opencode/paid-claude-sonnet']).toBeUndefined();
        expect(finalConfig.models?.['opencode/paid-gpt-5']).toBeUndefined();
        expect(opencodeModels.length).toBeGreaterThan(0);
      },
      NETWORK_TIMEOUT,
    );

    it.skipIf(!hasKiloKey)(
      'kilo: after catalog refresh with free_models_only, config has ONLY free models',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            kilo: { type: 'openai', baseUrl: KILO_BASE, apiKey: KILO_KEY, free_models_only: true },
          },
          models: {
            'kilo/paid-claude-opus': { provider: 'kilo', model: 'anthropic/claude-opus-4', maxContextSize: 200000 },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        const result = await refreshProviderCatalog(host, {});

        expect(result.failed).toEqual([]);

        const finalConfig = getConfig();
        const kiloModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'kilo',
        );

        console.log(`  kilo final: ${kiloModels.length} models in config`);
        for (const [alias] of kiloModels) {
          console.log(`    ${alias}`);
        }

        for (const [alias] of kiloModels) {
          expect(alias.toLowerCase()).toContain('free');
        }

        expect(finalConfig.models?.['kilo/paid-claude-opus']).toBeUndefined();
        expect(kiloModels.length).toBeGreaterThan(0);
      },
      NETWORK_TIMEOUT,
    );

    it.skipIf(!hasOpenRouterKey || !hasKiloKey)(
      'multi-provider: openrouter (free_only) + kilo (free_only) + opencode-go (no flag) all refresh correctly',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            openrouter: { type: 'openai', baseUrl: OPENROUTER_BASE, apiKey: OPENROUTER_KEY, free_models_only: true },
            kilo: { type: 'openai', baseUrl: KILO_BASE, apiKey: KILO_KEY, free_models_only: true },
            'opencode-go': { type: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: process.env['OPENCODE_GO_API_KEY'] ?? '' },
          },
          models: {
            'openrouter/old-paid': { provider: 'openrouter', model: 'old-paid', maxContextSize: 100000 },
            'kilo/old-paid': { provider: 'kilo', model: 'old-paid', maxContextSize: 100000 },
            'opencode-go/mimo-v2.5': { provider: 'opencode-go', model: 'mimo-v2.5', maxContextSize: 262144 },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        const result = await refreshProviderCatalog(host, {});

        console.log('  changed:', result.changed.map((c) => `${c.providerId} (+${c.added}/-${c.removed})`).join(', '));
        console.log('  unchanged:', result.unchanged.join(', '));
        console.log('  failed:', result.failed.map((f) => `${f.provider}: ${f.reason}`).join(', '));

        const finalConfig = getConfig();

        const orModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'openrouter',
        );
        for (const [alias] of orModels) {
          expect(alias.toLowerCase()).toContain('free');
        }
        expect(orModels.length).toBeGreaterThan(0);
        console.log(`  openrouter: ${orModels.length} models (all free)`);

        const kiloModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'kilo',
        );
        for (const [alias] of kiloModels) {
          expect(alias.toLowerCase()).toContain('free');
        }
        expect(kiloModels.length).toBeGreaterThan(0);
        console.log(`  kilo: ${kiloModels.length} models (all free)`);

        const ocgModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'opencode-go',
        );
        expect(ocgModels.length).toBeGreaterThan(0);
        console.log(`  opencode-go: ${ocgModels.length} models (unfiltered)`);

        expect(finalConfig.models?.['openrouter/old-paid']).toBeUndefined();
        expect(finalConfig.models?.['kilo/old-paid']).toBeUndefined();
      },
      NETWORK_TIMEOUT * 2,
    );

    it.skipIf(!hasOpenRouterKey || !hasKiloKey)(
      'scoped refresh: refreshProviderCatalog with providerId only touches that provider',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            openrouter: { type: 'openai', baseUrl: OPENROUTER_BASE, apiKey: OPENROUTER_KEY, free_models_only: true },
            kilo: { type: 'openai', baseUrl: KILO_BASE, apiKey: KILO_KEY, free_models_only: true },
          },
          models: {
            'openrouter/old-paid': { provider: 'openrouter', model: 'old-paid', maxContextSize: 100000 },
            'kilo/old-paid': { provider: 'kilo', model: 'old-paid', maxContextSize: 100000 },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        const result = await refreshProviderCatalog(host, { providerId: 'openrouter' });

        expect(result.failed).toEqual([]);

        const finalConfig = getConfig();

        const orModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'openrouter',
        );
        for (const [alias] of orModels) {
          expect(alias.toLowerCase()).toContain('free');
        }
        console.log(`  openrouter (scoped): ${orModels.length} models`);

        const kiloModels = Object.entries(finalConfig.models ?? {}).filter(
          ([, m]) => (m as { provider?: string }).provider === 'kilo',
        );
        expect(kiloModels.length).toBe(1);
        expect(kiloModels[0]?.[0]).toBe('kilo/old-paid');
        console.log(`  kilo (untouched): ${kiloModels.length} model (old paid still present)`);
      },
      NETWORK_TIMEOUT * 2,
    );
  });

  describe('expected free model IDs', () => {
    it.skipIf(!hasOpenRouterKey)(
      'openrouter free models include known IDs, paid models excluded',
      async () => {
        const config: ManagedKimiConfigShape = {
          providers: {
            openrouter: { type: 'openai', baseUrl: OPENROUTER_BASE, apiKey: OPENROUTER_KEY, free_models_only: true },
          },
          telemetry: true,
        };

        const { host, getConfig } = makeHost(config);
        await refreshProviderCatalog(host, {});

        const finalConfig = getConfig();
        const modelIds = Object.values(finalConfig.models ?? {})
          .filter((m) => (m as { provider?: string }).provider === 'openrouter')
          .map((m) => (m as { model: string }).model);

        expect(modelIds).toContain('nvidia/nemotron-3.5-lightning:free');
        expect(modelIds).toContain('nvidia/nemotron-3-super-120b-a12b:free');
        expect(modelIds).toContain('z-ai/glm-5.2:free');

        expect(modelIds).not.toContain('anthropic/claude-opus-4');
        expect(modelIds).not.toContain('openai/gpt-4o');
        expect(modelIds).not.toContain('deepseek/deepseek-r1');

        console.log(`  Verified ${modelIds.length} free models, paid models correctly excluded`);
      },
      NETWORK_TIMEOUT,
    );
  });
});
