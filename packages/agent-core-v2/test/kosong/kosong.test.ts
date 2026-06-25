import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ILogger } from '#/log/log';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { IEnvironmentService } from '#/environment/environment';
import { IModelCatalogService } from '#/kosong/kosong';
import { ILogService } from '#/log/log';

import { ConfigRegistry, ConfigService } from '#/config/configService';
import { ModelCatalogService, ProviderManager } from '#/kosong/kosongService';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};
const noopLog: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
};

const unusedEnv: IEnvironmentService = {
  _serviceBrand: undefined,
  homeDir: '',
  configPath: '',
  detect: () => Promise.reject(new Error('unused')),
};

describe('ModelCatalogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let catalog: ModelCatalogService;

  beforeEach(async () => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigRegistry, new ConfigRegistry());
    ix.stub(IEnvironmentService, unusedEnv);
    ix.stub(ILogService, noopLog);
    const config = disposables.add(ix.createInstance(ConfigService));
    ix.set(IConfigService, config);
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
    catalog = ix.createInstance(ModelCatalogService);
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
  let config: ConfigService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigRegistry, new ConfigRegistry());
    ix.stub(IEnvironmentService, unusedEnv);
    ix.stub(ILogService, noopLog);
    config = disposables.add(ix.createInstance(ConfigService));
    ix.set(IConfigService, config);
    ix.set(IModelCatalogService, new SyncDescriptor(ModelCatalogService));
  });
  afterEach(() => disposables.dispose());

  async function make(): Promise<ProviderManager> {
    await config.set('kosong', {
      providers: [{ id: 'kimi', name: 'Kimi' }],
      models: [{ id: 'k2', providerId: 'kimi' }],
      defaultProviderId: 'kimi',
      defaultModelId: 'k2',
    });
    return ix.createInstance(ProviderManager);
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
    const pm = ix.createInstance(ProviderManager);
    await expect(pm.resolve()).rejects.toThrow(/no defaults/);
  });
});
