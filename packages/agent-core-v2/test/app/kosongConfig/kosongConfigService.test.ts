/**
 * `kosongConfig` bridge tests — `KosongConfigService`, the two-way sync
 * between `IConfigService` (persistence) and kosong's in-memory
 * provider/model registries:
 *
 *  - startup hydration: after `config.ready` the registries are loaded from
 *    the effective config view (records + default pointers) and become
 *    `ready` themselves;
 *  - kosong → config: registry mutations (`set` / `setDefaultModel` / ...)
 *    persist through `config.replace`, serialized in event order; an awaited
 *    mutation only resolves after the persist has landed, and a failed
 *    persist is retried with backoff before being logged;
 *  - config → kosong: section writes (`config.set` / `config.replace`) land
 *    in the registries;
 *  - loop termination: equal writes are silent on the registry side and the
 *    persist handlers skip writes when config already matches, so neither
 *    direction echoes back into the other;
 *  - deleting the default provider clears the pointer and persists the
 *    cleared pointer.
 *
 * The bridge is instantiated directly with the real registries, the shared
 * `StubConfigService`, and a stub log — no DI involved.
 */

import { describe, expect, it, vi } from 'vitest';

import { ILogService, type LogPayload } from '#/_base/log/log';
import {
  DEFAULT_MODEL_SECTION,
  DEFAULT_PROVIDER_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
} from '#/app/kosongConfig/configSection';
import { type ModelRecord } from '#/kosong/model/model';
import { ModelService } from '#/kosong/model/modelService';
import { type ProviderConfig } from '#/kosong/provider/provider';
import { ProviderService } from '#/kosong/provider/providerService';

import { StubConfigService } from '../../kosong/stubs';
import { KosongConfigService } from '#/app/kosongConfig/kosongConfigService';

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
  readonly providers: ProviderService;
  readonly models: ModelService;
  readonly log: ReturnType<typeof stubLogService>;
  readonly bridge: KosongConfigService;
}

async function createBridge(sections: Record<string, unknown> = {}): Promise<BridgeFixture> {
  const config = new StubConfigService(sections);
  const providers = new ProviderService();
  const models = new ModelService();
  const log = stubLogService();
  const bridge = new KosongConfigService(config, providers, models, log);
  await bridge.ready;
  return { config, providers, models, log, bridge };
}

/** Let the bridge's serialized persist chain (and event handlers) run out. */
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

    expect(providers.list()).toEqual({ kimi: KIMI_PROVIDER });
    expect(providers.getDefaultProvider()).toBe('kimi');
    expect(models.list()).toEqual({ k1: K1_MODEL });
    expect(models.getDefaultModel()).toBe('k1');
    // Both registries are hydrated — `ready` has resolved.
    await expect(providers.ready).resolves.toBeUndefined();
    await expect(models.ready).resolves.toBeUndefined();
  });

  it('hydrates empty registries from an empty config', async () => {
    const { providers, models } = await createBridge();

    expect(providers.list()).toEqual({});
    expect(providers.getDefaultProvider()).toBeUndefined();
    expect(models.list()).toEqual({});
    expect(models.getDefaultModel()).toBeUndefined();
  });
});

describe('KosongConfigService kosong → config persistence', () => {
  it('persists provider set/delete through config.replace with the whole section', async () => {
    const { config, providers, bridge } = await createBridge(seededSections);
    try {
      const replaceSpy = vi.spyOn(config, 'replace');

      await providers.set('openai', { type: 'openai', apiKey: 'sk-o' });
      await flush();
      expect(replaceSpy).toHaveBeenCalledWith(PROVIDERS_SECTION, {
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });

      await providers.delete('openai');
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
      await models.set('k2', { provider: 'kimi', model: 'kimi-k2.5', maxContextSize: 2000 });
      await models.setDefaultModel('k2');
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
      await providers.set('openai', { type: 'openai' });
      await providers.setDefaultProvider('openai');
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
      // No flush(): the mutation's own await already covers persistence.
      await providers.set('openai', { type: 'openai', apiKey: 'sk-o' });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
        openai: { type: 'openai', apiKey: 'sk-o' },
      });

      await models.setDefaultModel('k1');
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
        const pending = providers.set('openai', { type: 'openai' });
        // The first backoff is ~500ms; advancing past it lets the retry run.
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
        const pending = providers.set('openai', { type: 'openai' });
        // Two backoffs (~500ms + ~1000ms, plus jitter) before the budget is spent.
        await vi.advanceTimersByTimeAsync(2500);
        // The caller is never rejected: the in-memory change stands.
        await pending;
      } finally {
        vi.useRealTimers();
      }

      expect(providers.get('openai')).toEqual({ type: 'openai' });
      expect(config.get<Record<string, ProviderConfig>>(PROVIDERS_SECTION)).toEqual({
        kimi: KIMI_PROVIDER,
      });
      expect(log.warnings).toHaveLength(1);
      expect(log.warnings[0]?.message).toBe('kosong config persist failed');

      // A poisoned task must not stall the persists queued behind it.
      replaceSpy.mockRestore();
      await providers.set('mistral', { type: 'mistral' });
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
      expect(providers.get('openai')).toEqual({ type: 'openai', apiKey: 'sk-o' });
      expect(providers.get('kimi')).toEqual(KIMI_PROVIDER);

      await config.replace(MODELS_SECTION, { k2: { provider: 'openai', model: 'gpt-5' } });
      expect(models.list()).toEqual({ k2: { provider: 'openai', model: 'gpt-5' } });

      await config.replace(DEFAULT_MODEL_SECTION, 'k2');
      await flush();
      expect(models.getDefaultModel()).toBe('k2');

      await config.replace(DEFAULT_PROVIDER_SECTION, 'openai');
      await flush();
      expect(providers.getDefaultProvider()).toBe('openai');
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

      await providers.set('openai', { type: 'openai' });
      await providers.setDefaultProvider('openai');
      await flush();

      // Exactly one event per mutation; the config write the persist caused
      // synced back equal values, which are silent.
      expect(events).toEqual(['providers', 'defaultProvider']);
      // And the persist did not re-persist after the echo: exactly one
      // providers-section replace plus one pointer replace.
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

      expect(providers.get('openai')).toEqual({ type: 'openai' });
      expect(models.get('k2')).toEqual({ provider: 'openai', model: 'gpt-5' });
      // The registry diffs fired, but the persist handlers saw config already
      // matching and skipped the write-back.
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

      await providers.delete('kimi');
      await flush();

      // The registry cleared the dangling pointer, and the cleared pointer
      // persisted.
      expect(providers.getDefaultProvider()).toBeUndefined();
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
  /**
   * Emulates an effective-overlay pin (e.g. `KIMI_MODEL_NAME` →
   * `defaultModel`): user-layer writes are accepted, but the effective read
   * (`get`) keeps returning the pinned value and no change event fires.
   */
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
    const providers = new ProviderService();
    const models = new ModelService();
    const bridge = new KosongConfigService(config, providers, models, stubLogService());
    await bridge.ready;
    try {
      // Hydration reads the effective view: the pinned value, not the seeded one.
      expect(models.getDefaultModel()).toBe('env-model');
      const replaceSpy = vi.spyOn(config, 'replace');

      await models.setDefaultModel('k1');
      await flush();

      // The write landed in the user layer, but the pinned effective view
      // did not move, and the bridge reconciled the registry back to the pin.
      expect(replaceSpy).toHaveBeenCalledWith(DEFAULT_MODEL_SECTION, 'k1');
      expect(models.getDefaultModel()).toBe('env-model');
    } finally {
      bridge.dispose();
    }
  });
});
