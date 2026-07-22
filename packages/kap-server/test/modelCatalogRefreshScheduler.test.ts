import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IConfigService,
  IProviderDiscoveryService,
  ModelCatalogConfig,
} from '@moonshot-ai/agent-core-v2';

import { ModelCatalogRefreshScheduler } from '../src/services/modelCatalog/modelCatalogRefreshScheduler';
import type { ServerLogger } from '../src/services/pinoLoggerService';

const EMPTY_RESULT = { changed: [], unchanged: [], failed: [] };

function makeCatalog(refreshProviderModels = vi.fn(async () => EMPTY_RESULT)) {
  return { refreshProviderModels } as unknown as IProviderDiscoveryService;
}

function makeConfig(catalogConfig?: ModelCatalogConfig): IConfigService {
  return {
    ready: Promise.resolve(),
    get: vi.fn((domain: string) => (domain === 'modelCatalog' ? catalogConfig : undefined)),
  } as unknown as IConfigService;
}

function makeLogger(): Pick<ServerLogger, 'info' | 'warn'> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('ModelCatalogRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('refreshes on start and then on the configured interval', async () => {
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(catalog, makeConfig(), makeLogger(), {});

    await scheduler.start();
    await vi.waitFor(() => {
      expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
    });
    expect(catalog.refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);
  });

  it('honors env overrides for interval and refresh-on-start', async () => {
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(catalog, makeConfig(), makeLogger(), {
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('reads interval and refresh-on-start from the modelCatalog config section', async () => {
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 1000, refreshOnStart: false }),
      makeLogger(),
      {},
    );

    await scheduler.start();
    // refreshOnStart=false → no startup refresh.
    await vi.advanceTimersByTimeAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
    // interval=1000 → first interval refresh at 1000ms.
    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('lets env override the modelCatalog config section', async () => {
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 6 * 60 * 60 * 1000, refreshOnStart: true }),
      makeLogger(),
      {
        KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
        KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
      },
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('disables the schedule when the config interval is 0', async () => {
    const catalog = makeCatalog();
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog,
      makeConfig({ refreshIntervalMs: 0, refreshOnStart: false }),
      makeLogger(),
      {},
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('swallows refresh errors so a failing tick does not break the schedule', async () => {
    const refreshProviderModels = vi.fn().mockRejectedValue(new Error('network down'));
    const catalog = makeCatalog(refreshProviderModels);
    const logger = makeLogger();
    const scheduler = new ModelCatalogRefreshScheduler(catalog, makeConfig(), logger, {
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '1000',
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: 'false',
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
