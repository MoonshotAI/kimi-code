import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/config/config';
import { IModelCatalogService, IProviderManager } from '#/kosong/kosong';

import { ConfigService } from '#/config/configService';
import { ModelCatalogService, ProviderManager } from '#/kosong/kosongService';
import { registerConfigServices } from '../config/stubs';
import { registerEnvironmentServices } from '../environment/stubs';
import { registerLogServices } from '../log/stubs';

describe('ModelCatalogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let catalog: IModelCatalogService;

  beforeEach(async () => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerEnvironmentServices,
        registerLogServices,
      ],
      additionalServices: (reg) => {
        reg.define(IConfigService, ConfigService);
        reg.define(IModelCatalogService, ModelCatalogService);
      },
    });
    const config = ix.get(IConfigService);
    await config.set('kosong', {
      providers: [
        { id: 'kimi', name: 'Kimi' },
        { id: 'other', name: 'Other' },
      ],
      models: [
        { id: 'k2', providerId: 'kimi' },
        { id: 'o1', providerId: 'other' },
      ],
      defaultProviderId: 'kimi',
      defaultModelId: 'k2',
    });
    catalog = ix.get(IModelCatalogService);
  });
  afterEach(() => disposables.dispose());

  it('lists providers from config', async () => {
    expect(await catalog.listProviders()).toEqual([
      { id: 'kimi', name: 'Kimi' },
      { id: 'other', name: 'Other' },
    ]);
  });

  it('lists models, optionally filtered by provider', async () => {
    expect(await catalog.listModels()).toHaveLength(2);
    expect(await catalog.listModels('kimi')).toEqual([{ id: 'k2', providerId: 'kimi' }]);
  });
});

describe('ProviderManager', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let config: IConfigService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerEnvironmentServices,
        registerLogServices,
      ],
      additionalServices: (reg) => {
        reg.define(IConfigService, ConfigService);
        reg.define(IModelCatalogService, ModelCatalogService);
        reg.define(IProviderManager, ProviderManager);
      },
    });
    config = ix.get(IConfigService);
  });
  afterEach(() => disposables.dispose());

  async function make(): Promise<IProviderManager> {
    await config.set('kosong', {
      providers: [{ id: 'kimi', name: 'Kimi' }],
      models: [{ id: 'k2', providerId: 'kimi' }],
      defaultProviderId: 'kimi',
      defaultModelId: 'k2',
    });
    return ix.get(IProviderManager);
  }

  it('resolves defaults when no ids given', async () => {
    const pm = await make();
    expect(await pm.resolve()).toEqual({ providerId: 'kimi', modelId: 'k2' });
  });

  it('resolves explicit ids', async () => {
    const pm = await make();
    expect(await pm.resolve('kimi', 'k2')).toEqual({ providerId: 'kimi', modelId: 'k2' });
  });

  it('throws on unknown provider', async () => {
    const pm = await make();
    await expect(pm.resolve('nope', 'k2')).rejects.toThrow(/unknown provider/);
  });

  it('throws when no defaults and no ids', async () => {
    await config.set('kosong', { providers: [{ id: 'kimi', name: 'Kimi' }] });
    const pm = ix.get(IProviderManager);
    await expect(pm.resolve()).rejects.toThrow(/no defaults/);
  });
});
