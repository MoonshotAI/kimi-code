/**
 * `provider` domain tests — covers `ProviderService` CRUD over the `providers`
 * config section, schema registration, and the delete-via-replace semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { ConfigRegistry } from '#/config/configService';
import { IProviderService, type ProviderConfig, PROVIDERS_SECTION } from '#/provider/provider';
import { ProviderService } from '#/provider/providerService';

describe('ProviderService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registry: ConfigRegistry;
  let providers: Record<string, ProviderConfig>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    registry = new ConfigRegistry();
    providers = {};
    configSet = vi.fn().mockResolvedValue(undefined);
    configReplace = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === PROVIDERS_SECTION ? providers : undefined) as IConfigService['get'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          onDidChange: (() => ({ dispose: () => {} })) as IConfigService['onDidChange'],
        });
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createService(): IProviderService {
    return ix.createInstance(ProviderService);
  }

  it('registers the providers section schema on construction', () => {
    createService();
    expect(registry.getSection(PROVIDERS_SECTION)).toBeDefined();
  });

  it('set delegates to config.set with a single-provider patch', async () => {
    const svc = createService();
    await svc.set('p1', { type: 'openai', apiKey: 'sk' });
    expect(configSet).toHaveBeenCalledWith(PROVIDERS_SECTION, {
      p1: { type: 'openai', apiKey: 'sk' },
    });
  });

  it('get reads a single provider from config', () => {
    providers['p1'] = { type: 'openai', apiKey: 'sk' };
    const svc = createService();
    expect(svc.get('p1')).toEqual({ type: 'openai', apiKey: 'sk' });
    expect(svc.get('missing')).toBeUndefined();
  });

  it('list returns all providers', () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    const svc = createService();
    expect(svc.list()).toEqual({
      p1: { type: 'openai' },
      p2: { type: 'kimi' },
    });
  });

  it('delete removes the provider and replaces the whole section', async () => {
    providers['p1'] = { type: 'openai' };
    providers['p2'] = { type: 'kimi' };
    const svc = createService();
    await svc.delete('p1');
    expect(configReplace).toHaveBeenCalledWith(PROVIDERS_SECTION, {
      p2: { type: 'kimi' },
    });
  });

  it('delete is a no-op when the provider is absent', async () => {
    const svc = createService();
    await svc.delete('missing');
    expect(configReplace).not.toHaveBeenCalled();
  });
});
