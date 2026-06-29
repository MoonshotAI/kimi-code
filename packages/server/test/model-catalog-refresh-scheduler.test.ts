import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ICoreProcessService, ILogService, IModelCatalogService } from '@moonshot-ai/agent-core';

import { ModelCatalogRefreshScheduler } from '../src/services/modelCatalog/modelCatalogRefreshScheduler';

interface MockCatalog {
  refreshProviderModels: ReturnType<typeof vi.fn>;
}

function makeCore(modelCatalog?: { refreshIntervalMs?: number; refreshOnStart?: boolean }): ICoreProcessService {
  return {
    _serviceBrand: undefined,
    rpc: {
      getKimiConfig: vi.fn(async () => ({ providers: {}, modelCatalog })),
    },
    ready: async () => undefined,
    dispose: () => undefined,
  } as unknown as ICoreProcessService;
}

function makeLogger(): ILogService {
  const logger = {
    _serviceBrand: undefined,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as ILogService;
}

describe('ModelCatalogRefreshScheduler', () => {
  let catalog: MockCatalog;

  beforeEach(() => {
    vi.useFakeTimers();
    catalog = {
      refreshProviderModels: vi.fn(async () => ({ changed: [], unchanged: [], failed: [] })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('refreshes on start and then on the configured interval', async () => {
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog as unknown as IModelCatalogService,
      makeCore({ refreshIntervalMs: 60_000, refreshOnStart: true }),
      makeLogger(),
    );

    await scheduler.start();
    // The startup refresh is fire-and-forget; wait for its microtask to land.
    await vi.waitFor(() => {
      expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
    });
    expect(catalog.refreshProviderModels).toHaveBeenCalledWith({ scope: 'all' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);
  });

  it('does nothing when interval is 0 and refreshOnStart is false', async () => {
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog as unknown as IModelCatalogService,
      makeCore({ refreshIntervalMs: 0, refreshOnStart: false }),
      makeLogger(),
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('honors env overrides for interval and refresh-on-start', async () => {
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', '1000');
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', '0');
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog as unknown as IModelCatalogService,
      // Config says 6h + refresh on start, but env should win.
      makeCore({ refreshIntervalMs: 6 * 60 * 60 * 1000, refreshOnStart: true }),
      makeLogger(),
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(catalog.refreshProviderModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it('swallows refresh errors so a failing tick does not break the schedule', async () => {
    catalog.refreshProviderModels.mockRejectedValue(new Error('network down'));
    const scheduler = new ModelCatalogRefreshScheduler(
      catalog as unknown as IModelCatalogService,
      makeCore({ refreshIntervalMs: 1000, refreshOnStart: false }),
      makeLogger(),
    );

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(catalog.refreshProviderModels).toHaveBeenCalledTimes(2);
  });
});
