import type {
  KimiConfig,
  KimiHarness,
  RefreshProviderModelsResponse,
} from "@moonshot-ai/kimi-code-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelCatalogRefreshScheduler } from "../src/runtime/model-catalog-refresh-scheduler";

const EMPTY_RESULT: RefreshProviderModelsResponse = { changed: [], unchanged: [], failed: [] };
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CONFIG: KimiConfig = { providers: {} };
const EMPTY_ENV: NodeJS.ProcessEnv = {};

function makeHarness(config: KimiConfig = DEFAULT_CONFIG) {
  return {
    getConfig: vi.fn(async () => config),
    refreshProviderModels: vi.fn(async () => EMPTY_RESULT),
  };
}

const schedulers: ModelCatalogRefreshScheduler[] = [];

function makeScheduler(
  harness: Pick<KimiHarness, "getConfig" | "refreshProviderModels">,
  env: NodeJS.ProcessEnv = EMPTY_ENV,
) {
  const onRefreshed = vi.fn();
  const log = vi.fn();
  const scheduler = new ModelCatalogRefreshScheduler({ harness, onRefreshed, log, env });
  schedulers.push(scheduler);
  return { scheduler, onRefreshed, log };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("VS Code model catalog refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose();
    vi.useRealTimers();
  });

  it("refreshes on startup and every six hours, then stops after disposal", async () => {
    const harness = makeHarness();
    const { scheduler, onRefreshed } = makeScheduler(harness);

    await scheduler.start();
    await scheduler.start();
    await flush();

    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);
    expect(harness.refreshProviderModels).toHaveBeenCalledWith({ scope: "all" });
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(harness.getConfig).toHaveBeenCalledTimes(2);
    expect(harness.getConfig).toHaveBeenNthCalledWith(1, { reload: true });
    expect(harness.getConfig).toHaveBeenNthCalledWith(2, { reload: true });

    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(onRefreshed).toHaveBeenCalledTimes(2);

    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(2);
  });

  it("honors env overrides for interval and refresh-on-start", async () => {
    const harness = makeHarness({
      providers: {},
      modelCatalog: { refreshIntervalMs: SIX_HOURS_MS, refreshOnStart: true },
    });
    const { scheduler } = makeScheduler(harness, {
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "1000",
      KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "0",
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.refreshProviderModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it("reads interval and refresh-on-start from modelCatalog config", async () => {
    const harness = makeHarness({
      providers: {},
      modelCatalog: { refreshIntervalMs: 1000, refreshOnStart: false },
    });
    const { scheduler } = makeScheduler(harness);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.refreshProviderModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it("lets a zero config interval disable the schedule", async () => {
    const harness = makeHarness({
      providers: {},
      modelCatalog: { refreshIntervalMs: 0, refreshOnStart: false },
    });
    const { scheduler } = makeScheduler(harness);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);

    expect(harness.refreshProviderModels).not.toHaveBeenCalled();
  });

  it("broadcasts successful provider updates when another provider fails", async () => {
    const harness = makeHarness();
    harness.refreshProviderModels.mockResolvedValue({
      changed: [],
      unchanged: [],
      failed: [{ provider: "example-provider", reason: "network down" }],
    });
    const { scheduler, onRefreshed, log } = makeScheduler(harness);

    await scheduler.start();
    await flush();

    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Provider-model catalog startup refresh skipped example-provider: network down",
    );
  });

  it("keeps later ticks running after a refresh failure", async () => {
    const harness = makeHarness();
    harness.refreshProviderModels.mockRejectedValue(new Error("network down"));
    const { scheduler, onRefreshed, log } = makeScheduler(harness, {
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "1000",
    });

    await scheduler.start();
    await flush();
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it("skips interval ticks while an earlier refresh is still running", async () => {
    const harness = makeHarness();
    let resolveRefresh!: (result: RefreshProviderModelsResponse) => void;
    harness.refreshProviderModels.mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const { scheduler, onRefreshed } = makeScheduler(harness, {
      KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: "1000",
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);

    resolveRefresh(EMPTY_RESULT);
    await flush();
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(2);
  });

  it("does not overflow intervals above the Node timeout limit into rapid refresh", async () => {
    const harness = makeHarness({
      providers: {},
      modelCatalog: { refreshIntervalMs: 2_147_484_647, refreshOnStart: false },
    });
    const { scheduler } = makeScheduler(harness);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(harness.refreshProviderModels).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast an in-flight refresh after disposal", async () => {
    const harness = makeHarness();
    let resolveRefresh!: (result: RefreshProviderModelsResponse) => void;
    harness.refreshProviderModels.mockReturnValue(new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const { scheduler, onRefreshed } = makeScheduler(harness);

    await scheduler.start();
    expect(harness.refreshProviderModels).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    resolveRefresh(EMPTY_RESULT);
    await flush();

    expect(onRefreshed).not.toHaveBeenCalled();
    expect(harness.getConfig).toHaveBeenCalledTimes(1);
  });
});
