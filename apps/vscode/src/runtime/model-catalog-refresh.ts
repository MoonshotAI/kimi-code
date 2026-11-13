import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 2_147_483_647;
const INTERVAL_ENV = "KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS";
const REFRESH_ON_START_ENV = "KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START";

export interface ModelCatalogRefreshOptions {
  readonly harness: Pick<KimiHarness, "getConfig" | "refreshProviderModels">;
  readonly onChanged: () => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export function startModelCatalogRefresh(options: ModelCatalogRefreshOptions): () => void {
  const env = options.env ?? process.env;
  let disposed = false;
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = async (): Promise<void> => {
    if (disposed || refreshing) return;
    refreshing = true;
    try {
      const result = await options.harness.refreshProviderModels({ scope: "all" });
      if (result.failed.length > 0) {
        options.log("Model catalog refresh completed with failures", result.failed);
      }
      if (!disposed && result.changed.length > 0) {
        options.onChanged();
      }
    } catch (error) {
      options.log("Model catalog refresh failed", error);
    } finally {
      refreshing = false;
    }
  };

  void (async () => {
    try {
      const config = await options.harness.getConfig();
      if (disposed) return;
      const intervalMs = resolveIntervalMs(env, config.modelCatalog?.refreshIntervalMs);
      const refreshOnStart = resolveRefreshOnStart(env, config.modelCatalog?.refreshOnStart);

      if (refreshOnStart) {
        void refresh();
      }
      if (intervalMs > 0) {
        timer = setInterval(() => void refresh(), intervalMs);
        timer.unref?.();
      }
    } catch (error) {
      options.log("Failed to start model catalog refresh", error);
    }
  })();

  return () => {
    disposed = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function resolveIntervalMs(env: NodeJS.ProcessEnv, configValue: number | undefined): number {
  const raw = env[INTERVAL_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_INTERVAL_MS) return parsed;
  }
  return Math.min(configValue ?? DEFAULT_REFRESH_INTERVAL_MS, MAX_INTERVAL_MS);
}

function resolveRefreshOnStart(env: NodeJS.ProcessEnv, configValue: boolean | undefined): boolean {
  const raw = env[REFRESH_ON_START_ENV];
  if (raw !== undefined && raw.trim().length > 0) {
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return configValue ?? true;
}
