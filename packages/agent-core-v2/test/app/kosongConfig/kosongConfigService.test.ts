import { describe, expect, it, vi } from 'vitest';

import { ILogService, type LogPayload } from '#/_base/log/log';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '#/app/kosongConfig/configSection';
import { type ModelRecord } from '#/provider-catalog/model/model';
import { type ProviderConfig } from '#/provider-catalog/provider/provider';

import { StubConfigService } from '../../stubs';
import { KosongConfigService } from '#/app/kosongConfig/kosongConfigService';
import { ProviderCatalogService } from '#/provider-catalog/providerCatalogService';

function stubLogService(): ILogService & { warnings: Array<{ message: string; payload?: LogPayload }> } {
  const warnings: Array<{ message: string; payload?: LogPayload }> = [];
  return {
    warnings,
    _serviceBrand: undefined,
    level: 'debug',
    setLevel: () => {},
    flush: async () => {},
    error: () => {},
    warn: (message: string, payload?: LogPayload) => {
      warnings.push({ message, payload });
    },
    info: () => {},
    debug: () => {},
    child: () => {
      throw new Error('child loggers are not used by KosongConfigService');
    },
  } satisfies ILogService & { warnings: Array<{ message: string; payload?: LogPayload }> };
}

interface BridgeFixture {
  readonly config: StubConfigService;
  readonly providers: ProviderCatalogService;
  readonly models: ProviderCatalogService;
  readonly log: ReturnType<typeof stubLogService>;
  readonly bridge: KosongConfigService;
}

async function createBridge(sections: Record<string, unknown> = {}): Promise<BridgeFixture> {
  const config = new StubConfigService(sections);
  const providerCatalog = new ProviderCatalogService();
  const log = stubLogService();
  const bridge = new KosongConfigService(config, providerCatalog, log);
  await bridge.ready;
  return { config, providers: providerCatalog, models: providerCatalog, log, bridge };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const KIMI_PROVIDER: ProviderConfig = { type: 'kimi', apiKey: 'sk-test' };
const K1_MODEL: ModelRecord = { provider: 'kimi', model: 'kimi-k2', maxContextSize: 1000 };

const seededSections: Record<string, unknown> = {
  providers: { kimi: KIMI_PROVIDER },
  models: { k1: K1_MODEL },
  defaultProvider: 'kimi',
  defaultModel: 'k1',
};

describe('KosongConfigService startup hydration', () => {
  it('loads providers, models, and the default pointers from config and readies the registries', async () => {
    const { providers, models } = await createBridge(seededSections);

    expect(providers.listProviderConfigs()).toEqual({ kimi: KIMI_PROVIDER });
    expect(providers.getDefaultProviderId()).toBe('kimi');
    expect(models.listModelRecords()).toEqual({ k1: K1_MODEL });
    expect(models.getDefaultModelId()).toBe('k1');
    await expect(providers.ready).resolves.toBeUndefined();
    await expect(models.ready).resolves.toBeUndefined();
  });

  it('hydrates empty registries from an empty config', async () => {
    const { providers, models } = await createBridge();

    expect(providers.listProviderConfigs()).toEqual({});
    expect(providers.getDefaultProviderId()).toBeUndefined();
    expect(models.listModelRecords()).toEqual({});
    expect(models.getDefaultModelId()).toBeUndefined();
  });
});

describe('KosongConfigService kosong → config persistence', () => {
  it('persists provider set/delete through config.replace with the whole section', async () => {
    const { config, providers, bridge } = await createBridge(seededSections);
    try {
      const replaceSpy = vi.spyOn(config, 'replace');

      await providers.setProviderConfig('openai', { type: 'openai', apiKey: 'sk-o' });
      await flush();
      expect(replaceSpy).toHaveBeenCalledWith(PROVIDERS_SECTION, {
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });

      await providers.deleteProviderConfig('openai');
      await flush();
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
      });
    } finally {
      bridge.dispose();
    }
  });

  it('persists model records and the default-model pointer', async () => {
    const { config, models, bridge } = await createBridge(seededSections);
    try {
      await models.setModelRecord('k2', { provider: 'kimi', model: 'kimi-k2.5', maxContextSize: 2000 });
      await models.setDefaultModelId('k2');
      await flush();

      expect(config.get<Record<string, ModelRecord>>(MODELS_SECTION)).toEqual({
        k1: K1_MODEL,
        k2: { provider: 'kimi', model: 'kimi-k2.5', maxContextSize: 2000 },
      });
      expect(config.get<string>(DEFAULT_MODEL_SECTION)).toBe('k2');
    } finally {
      bridge.dispose();
    }
  });

  it('persists the default-provider pointer', async () => {
    const { config, providers, bridge } = await createBridge(seededSections);
    try {
      await providers.setProviderConfig('openai', { type: 'openai' });
      await providers.setDefaultProviderId('openai');
      await flush();

      expect(config.get<string>(DEFAULT_PROVIDER_SECTION)).toBe('openai');
    } finally {
      bridge.dispose();
    }
  });
});

describe('KosongConfigService awaited-mutation semantics', () => {
  it('an awaited registry mutation resolves only after the write has landed in config', async () => {
    const { config, providers, models, bridge } = await createBridge(seededSections);
    try {
      await providers.setProviderConfig('openai', { type: 'openai', apiKey: 'sk-o' });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });

      await models.setDefaultModelId('k1');
      expect(config.get<string>(DEFAULT_MODEL_SECTION)).toBe('k1');
    } finally {
      bridge.dispose();
    }
  });

  it('retries a failed persist instead of surfacing it to the caller', async () => {
    const { config, providers, log, bridge } = await createBridge(seededSections);
    try {
      let failuresLeft = 1;
      const original = config.replace.bind(config);
      vi.spyOn(config, 'replace').mockImplementation(async (domain: string, value: unknown) => {
        if (domain === PROVIDERS_SECTION && failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('disk busy');
        }
        return original(domain, value);
      });

      vi.useFakeTimers();
      try {
        const pending = providers.setProviderConfig('openai', { type: 'openai' });
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai' },
      });
      expect(log.warnings).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  });

  it('logs and resolves after the retry budget is spent, and the chain stays alive', async () => {
    const { config, providers, log, bridge } = await createBridge(seededSections);
    try {
      const replaceSpy = vi.spyOn(config, 'replace').mockRejectedValue(new Error('disk gone'));

      vi.useFakeTimers();
      try {
        const pending = providers.setProviderConfig('openai', { type: 'openai' });
        await vi.advanceTimersByTimeAsync(2500);
        await pending;
      } finally {
        vi.useRealTimers();
      }

      expect(providers.getProviderConfig('openai')).toEqual({ type: 'openai' });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
      });
      expect(log.warnings).toHaveLength(1);
      expect(log.warnings[0]?.message).toBe('kosong config persist failed');

      replaceSpy.mockRestore();
      await providers.setProviderConfig('mistral', { type: 'mistral' });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai' },
        mistral: { type: 'mistral' },
      });
    } finally {
      bridge.dispose();
    }
  });
});

describe('KosongConfigService config → kosong sync', () => {
  it('pushes config section writes into the registries', async () => {
    const { config, providers, models, bridge } = await createBridge(seededSections);
    try {
      await config.set(PROVIDERS_SECTION, { openai: { type: 'openai', apiKey: 'sk-o' } });
      expect(providers.getProviderConfig('openai')).toEqual({ type: 'openai', apiKey: 'sk-o' });
      expect(providers.getProviderConfig('kimi')).toEqual(KIMI_PROVIDER);

      await config.replace(MODELS_SECTION, { k2: { provider: 'openai', model: 'gpt-5' } });
      expect(models.listModelRecords()).toEqual({ k2: { provider: 'openai', model: 'gpt-5' } });

      await config.replace(DEFAULT_MODEL_SECTION, 'k2');
      await flush();
      expect(models.getDefaultModelId()).toBe('k2');

      await config.replace(DEFAULT_PROVIDER_SECTION, 'openai');
      await flush();
      expect(providers.getDefaultProviderId()).toBe('openai');
    } finally {
      bridge.dispose();
    }
  });
});

describe('KosongConfigService loop termination', () => {
  it('a kosong-originated persist does not echo back as a kosong change', async () => {
    const { config, providers, bridge } = await createBridge(seededSections);
    try {
      const replaceSpy = vi.spyOn(config, 'replace');
      const events: string[] = [];
      providers.onDidChangeProviders(() => events.push('providers'));
      providers.onDidChangeDefaultProvider(() => events.push('defaultProvider'));

      await providers.setProviderConfig('openai', { type: 'openai' });
      await providers.setDefaultProviderId('openai');
      await flush();

      expect(events).toEqual(['providers', 'defaultProvider']);
      expect(
        replaceSpy.mock.calls.filter(([domain]) => domain === PROVIDERS_SECTION),
      ).toHaveLength(1);
      expect(
        replaceSpy.mock.calls.filter(([domain]) => domain === DEFAULT_PROVIDER_SECTION),
      ).toHaveLength(1);
    } finally {
      bridge.dispose();
    }
  });

  it('a config-originated sync does not echo back as a config persist', async () => {
    const { config, providers, models, bridge } = await createBridge(seededSections);
    try {
      const replaceSpy = vi.spyOn(config, 'replace');
      replaceSpy.mockClear();

      await config.set(PROVIDERS_SECTION, { openai: { type: 'openai' } });
      await config.set(MODELS_SECTION, { k2: { provider: 'openai', model: 'gpt-5' } });
      await flush();

      expect(providers.getProviderConfig('openai')).toEqual({ type: 'openai' });
      expect(models.getModelRecord('k2')).toEqual({ provider: 'openai', model: 'gpt-5' });
      expect(replaceSpy).not.toHaveBeenCalled();
    } finally {
      bridge.dispose();
    }
  });
});

describe('KosongConfigService default-provider deletion', () => {
  it('clears the pointer when the default provider is deleted and persists the cleared pointer', async () => {
    const { config, providers, bridge } = await createBridge({
      ...seededSections,
      providers: { kimi: KIMI_PROVIDER, openai: { type: 'openai' } },
    });
    try {
      const replaceSpy = vi.spyOn(config, 'replace');

      await providers.deleteProviderConfig('kimi');
      await flush();

      expect(providers.getDefaultProviderId()).toBeUndefined();
      expect(replaceSpy).toHaveBeenCalledWith(PROVIDERS_SECTION, {
        openai: { type: 'openai' },
      });
      expect(replaceSpy).toHaveBeenCalledWith(DEFAULT_PROVIDER_SECTION, undefined);
      expect(config.get(DEFAULT_PROVIDER_SECTION)).toBeUndefined();
    } finally {
      bridge.dispose();
    }
  });
});

describe('KosongConfigService env-pinned default pointer', () => {
  class PinnedConfigService extends StubConfigService {
    constructor(
      private readonly pinnedDomain: string,
      pinnedValue: unknown,
      sections: Record<string, unknown>,
    ) {
      super({ ...sections, [pinnedDomain]: pinnedValue });
    }

    override replace(domain: string, value: unknown): Promise<void> {
      if (domain === this.pinnedDomain) return Promise.resolve();
      return super.replace(domain, value);
    }
  }

  it('re-asserts the pinned effective default model into the registry after a registry-originated write', async () => {
    const config = new PinnedConfigService(DEFAULT_MODEL_SECTION, 'env-model', seededSections);
    const models = new ProviderCatalogService();
    const bridge = new KosongConfigService(config, models, stubLogService());
    await bridge.ready;
    try {
      expect(models.getDefaultModelId()).toBe('env-model');
      const replaceSpy = vi.spyOn(config, 'replace');

      await models.setDefaultModelId('k1');
      await flush();

      expect(replaceSpy).toHaveBeenCalledWith(DEFAULT_MODEL_SECTION, 'k1');
      expect(models.getDefaultModelId()).toBe('env-model');
    } finally {
      bridge.dispose();
    }
  });
});
