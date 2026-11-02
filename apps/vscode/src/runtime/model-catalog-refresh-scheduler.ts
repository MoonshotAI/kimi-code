import type {
  KimiConfig,
  KimiHarness,
  RefreshProviderModelsResponse,
} from "@moonshot-ai/kimi-code-sdk";

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const INTERVAL_ENV = "KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS";
const REFRESH_ON_START_ENV = "KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START";

export interface ModelCatalogRefreshSchedulerOptions {
  readonly harness: Pick<KimiHarness, "getConfig" | "refreshProviderModels">;
  readonly onRefreshed: (config: KimiConfig, result: RefreshProviderModelsResponse) => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export class ModelCatalogRefreshScheduler {
  private readonly harness: ModelCatalogRefreshSchedulerOptions["harness"];
  private readonly onRefreshed: ModelCatalogRefreshSchedulerOptions["onRefreshed"];
  private readonly log: ModelCatalogRefreshSchedulerOptions["log"];
  private readonly env: NodeJS.ProcessEnv;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposed = false;
  private refreshing = false;

  constructor(options: ModelCatalogRefreshSchedulerOptions) {
    this.harness = options.harness;
    this.onRefreshed = options.onRefreshed;
    this.log = options.log;
    this.env = options.env ?? process.env;
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;

    let config: KimiConfig | undefined;
    try {
      config = await this.harness.getConfig({ reload: true });
    } catch (error) {
      this.log("Unable to read provider-model catalog refresh settings; using defaults", error);
    }
    if (this.disposed) return;

    const intervalMs = resolveIntervalMs(this.env, config?.modelCatalog?.refreshIntervalMs);
    const refreshOnStart = resolveRefreshOnStart(this.env, config?.modelCatalog?.refreshOnStart);
    if (refreshOnStart) void this.refresh("startup");

    if (intervalMs > 0) this.scheduleRefresh(intervalMs);
  }

  private scheduleRefresh(intervalMs: number): void {
    const deadline = Date.now() + intervalMs;
    const schedule = (remainingMs: number): void => {
      this.timer = setTimeout(() => {
        const remaining = deadline - Date.now();
        if (remaining > 0 && !this.disposed) {
          schedule(remaining);
          return;
        }
        this.timer = undefined;
        if (this.disposed) return;
        void this.refresh("interval").finally(() => {
          if (!this.disposed) this.scheduleRefresh(intervalMs);
        });
      }, Math.min(remainingMs, MAX_TIMEOUT_MS));
      this.timer.unref?.();
    };
    schedule(intervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async refresh(trigger: "startup" | "interval"): Promise<void> {
    if (this.refreshing || this.disposed) return;
    this.refreshing = true;
    try {
      const result = await this.harness.refreshProviderModels({ scope: "all" });
      if (this.disposed) return;
      for (const failure of result.failed) {
        this.log(`Provider-model catalog ${trigger} refresh skipped ${failure.provider}: ${failure.reason}`);
      }
      const config = await this.harness.getConfig({ reload: true });
      if (this.disposed) return;
      this.onRefreshed(config, result);
    } catch (error) {
      this.log(`Provider-model catalog ${trigger} refresh failed`, error);
    } finally {
      this.refreshing = false;
    }
  }
}

function resolveIntervalMs(env: NodeJS.ProcessEnv, configValue: number | undefined): number {
  const raw = env[INTERVAL_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return configValue ?? DEFAULT_REFRESH_INTERVAL_MS;
}

function resolveRefreshOnStart(env: NodeJS.ProcessEnv, configValue: boolean | undefined): boolean {
  const raw = env[REFRESH_ON_START_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return configValue ?? true;
}
