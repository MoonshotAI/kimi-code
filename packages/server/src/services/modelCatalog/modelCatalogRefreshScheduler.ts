/**
 * Periodic background refresh of provider model metadata for a long-lived
 * daemon. The original CLI refreshed `/models` at startup; once the server
 * became a daemon that started once and ran for days, the on-disk catalog went
 * stale. This scheduler restores "stays fresh" behavior: it refreshes once on
 * start and then on a configurable interval, delegating the actual work to
 * `IModelCatalogService.refreshProviderModels` (which serializes concurrent
 * runs, persists changes, and publishes `event.model_catalog.changed`).
 *
 * This is a server-local service (only the daemon is long-lived); the CLI uses
 * the same underlying refresh orchestrator but triggers it on demand.
 */

import {
  createDecorator,
  Disposable,
  ICoreProcessService,
  ILogService,
  IModelCatalogService,
} from '@moonshot-ai/agent-core';

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const INTERVAL_ENV = 'KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS';
const REFRESH_ON_START_ENV = 'KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START';

export interface IModelCatalogRefreshScheduler {
  readonly _serviceBrand: undefined;

  /** Read config and start the schedule. Idempotent. */
  start(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IModelCatalogRefreshScheduler = createDecorator<IModelCatalogRefreshScheduler>(
  'modelCatalogRefreshScheduler',
);

export class ModelCatalogRefreshScheduler
  extends Disposable
  implements IModelCatalogRefreshScheduler {
  readonly _serviceBrand: undefined;

  private _timer: ReturnType<typeof setInterval> | undefined;
  private _started = false;

  constructor(
    @IModelCatalogService private readonly modelCatalog: IModelCatalogService,
    @ICoreProcessService private readonly core: ICoreProcessService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    const config = await this.core.rpc.getKimiConfig({ reload: true });
    const intervalMs = resolveIntervalMs(config.modelCatalog?.refreshIntervalMs);
    const refreshOnStart = resolveRefreshOnStart(config.modelCatalog?.refreshOnStart);

    if (refreshOnStart) {
      // Fire-and-forget so boot is not blocked on a network round-trip.
      void this._refresh('startup');
    }

    if (intervalMs > 0) {
      this._timer = setInterval(() => void this._refresh('interval'), intervalMs);
      // Do not keep the process alive solely because of this timer.
      this._timer.unref?.();
      this.logger.info(
        { intervalMs },
        'provider-model catalog auto-refresh enabled',
      );
    }
  }

  private async _refresh(trigger: 'startup' | 'interval'): Promise<void> {
    try {
      const result = await this.modelCatalog.refreshProviderModels({ scope: 'all' });
      if (result.failed.length > 0) {
        this.logger.warn(
          { trigger, failed: result.failed },
          'provider-model catalog refresh completed with failures',
        );
      }
    } catch (error) {
      this.logger.warn(
        { trigger, err: error instanceof Error ? error.message : String(error) },
        'provider-model catalog refresh failed',
      );
    }
  }

  override dispose(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    super.dispose();
  }
}

function resolveIntervalMs(configValue: number | undefined): number {
  const raw = process.env[INTERVAL_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return configValue ?? DEFAULT_REFRESH_INTERVAL_MS;
}

function resolveRefreshOnStart(configValue: boolean | undefined): boolean {
  const raw = process.env[REFRESH_ON_START_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return configValue ?? true;
}
