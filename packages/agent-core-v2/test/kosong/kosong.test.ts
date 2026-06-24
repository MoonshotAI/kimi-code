import { beforeEach, describe, expect, it } from 'vitest';

import type { ILogService, ILogger } from '#/log/log';

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

describe('ModelCatalogService', () => {
  let config: ConfigService;
  let catalog: ModelCatalogService;

  beforeEach(async () => {
    config = new ConfigService(new ConfigRegistry(), undefined as never, noopLog);
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
    catalog = new ModelCatalogService(config, undefined as never);
  });

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
  async function make(): Promise<ProviderManager> {
    const config = new ConfigService(new ConfigRegistry(), undefined as never, noopLog);
    await config.set('kosong', {
      providers: [{ id: 'kimi', name: 'Kimi' }],
      models: [{ id: 'k2', providerId: 'kimi' }],
      defaultProviderId: 'kimi',
      defaultModelId: 'k2',
    });
    const catalog = new ModelCatalogService(config, undefined as never);
    return new ProviderManager(catalog, config);
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
    const config = new ConfigService(new ConfigRegistry(), undefined as never, noopLog);
    await config.set('kosong', { providers: [{ id: 'kimi', name: 'Kimi' }] });
    const catalog = new ModelCatalogService(config, undefined as never);
    const pm = new ProviderManager(catalog, config);
    await expect(pm.resolve()).rejects.toThrow(/no defaults/);
  });
});
