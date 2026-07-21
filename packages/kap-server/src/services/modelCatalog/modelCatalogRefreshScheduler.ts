/**
 * Periodic background refresh of provider model metadata for server-v2.
 *
 * Keeps a long-lived daemon's catalog fresh by refreshing once on start and
 * then on a configurable interval, delegating the work to
 * `IProviderDiscoveryService.refreshProviderModels({ scope: 'all' })` (which
 * refreshes every refreshable provider — managed OAuth + open platforms +
 * custom registries — and publishes `event.model_catalog.changed` on change).
 *
 * The cadence is config-driven: the `[model_catalog]` config section
 * (`refresh_interval_ms`, `refresh_on_start`) is read first, with the
 * `KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS` /
 * `KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START` env vars as overrides (matching
 * v1). When the config section is absent, the env vars / built-in defaults
 * apply. Failures are logged and swallowed so one bad tick does not break the
 * schedule.
 */

import {
  type IConfigService,
  type IProviderDiscoveryService,
  type ModelCatalogConfig,
  MODEL_CATALOG_SECTION,
} from '@moonshot-ai/agent-core-v2';

import type { ServerLogger } from '../pinoLoggerService';

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INTERVAL_ENV = 'KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS';
const REFRESH_ON_START_ENV = 'KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START';

export class ModelCatalogRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private disposed = false;

  constructor(
    private readonly discovery: IProviderDiscoveryService,
    private readonly config: IConfigService,
    private readonly logger: Pick<ServerLogger, 'info' | 'warn'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.config.ready;
    if (this.disposed) return;
    const catalogConfig = this.config.get<ModelCatalogConfig | undefined>(MODEL_CATALOG_SECTION);
    const intervalMs = resolveIntervalMs(this.env, catalogConfig?.refreshIntervalMs);
    const refreshOnStart = resolveRefreshOnStart(this.env, catalogConfig?.refreshOnStart);

    if (refreshOnStart) {
      void this.refresh('startup');
    }

    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.refresh('interval'), intervalMs);
      this.timer.unref?.();
      this.logger.info({ intervalMs }, 'provider-model catalog auto-refresh enabled');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async refresh(trigger: 'startup' | 'interval'): Promise<void> {
    try {
      const result = await this.discovery.refreshProviderModels({ scope: 'all' });
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
}

/** Env wins when set and valid; otherwise the config value; otherwise the default. */
function resolveIntervalMs(env: NodeJS.ProcessEnv, configValue: number | undefined): number {
  const raw = env[INTERVAL_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return configValue ?? DEFAULT_REFRESH_INTERVAL_MS;
}

/** Env wins when set; otherwise the config value; otherwise refresh-on-start defaults to on. */
function resolveRefreshOnStart(env: NodeJS.ProcessEnv, configValue: boolean | undefined): boolean {
  const raw = env[REFRESH_ON_START_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return configValue ?? true;
}
