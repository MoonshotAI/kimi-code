import {
  KIMI_CODE_PROVIDER_NAME,
  applyManagedKimiCodeConfig,
  applyOpenPlatformConfig,
  applyCustomRegistryProvider,
  clearManagedKimiCodeConfig,
  fetchCustomRegistry,
  fetchManagedKimiCodeModels,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  removeCustomRegistryProvider,
  removeOpenPlatformConfig,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type { KimiConfig, KimiConfigPatch, OAuthRef, ProviderConfig } from '@moonshot-ai/kimi-code-sdk';

export interface RefreshProviderHost {
  getConfig(): Promise<KimiConfig>;
  removeProvider(providerId: string): Promise<KimiConfig>;
  setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
  resolveOAuthToken(providerName: string, oauthRef?: OAuthRef): Promise<string>;
}

export interface ProviderChange {
  readonly providerId: string;
  /** User-facing name when available. */
  readonly providerName: string;
  readonly added: number;
  readonly removed: number;
}

export interface RefreshResult {
  /** Providers whose model list actually changed. */
  readonly changed: readonly ProviderChange[];
  /** Providers whose model list stayed identical after refresh. */
  readonly unchanged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly provider: string; readonly reason: string }>;
}

function readCustomRegistrySource(provider: ProviderConfig): CustomRegistrySource | undefined {
  const source = provider.source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source as Record<string, unknown>;
  if (candidate['kind'] !== 'apiJson') return undefined;
  const url = candidate['url'];
  const apiKey = candidate['apiKey'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (typeof apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url, apiKey };
}

function asManaged(config: KimiConfig): ManagedKimiConfigShape {
  return config as unknown as ManagedKimiConfigShape;
}

function collectModelIdsForProvider(config: KimiConfig, providerId: string): Set<string> {
  const ids = new Set<string>();
  for (const alias of Object.values(config.models ?? {})) {
    if (alias.provider === providerId && alias.model.length > 0) {
      ids.add(alias.model);
    }
  }
  return ids;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function computeChanges(oldIds: Set<string>, newIds: Set<string>): { added: number; removed: number } {
  let added = 0;
  for (const id of newIds) {
    if (!oldIds.has(id)) added++;
  }
  let removed = 0;
  for (const id of oldIds) {
    if (!newIds.has(id)) removed++;
  }
  return { added, removed };
}

function pickDefaultModel(config: KimiConfig, providerId: string, models: Array<{ id: string }>): string {
  const firstModel = models[0];
  if (firstModel === undefined) return '';

  const existingDefault = config.defaultModel;
  if (existingDefault !== undefined) {
    const alias = config.models?.[existingDefault];
    if (alias !== undefined && alias.provider === providerId) {
      const stillAvailable = models.find((m) => m.id === alias.model);
      if (stillAvailable !== undefined) {
        return stillAvailable.id;
      }
    }
  }
  return firstModel.id;
}

export async function refreshAllProviderModels(host: RefreshProviderHost): Promise<RefreshResult> {
  const changed: ProviderChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ provider: string; reason: string }> = [];

  let config = await host.getConfig();

  // -------------------------------------------------------------------------
  // 1. Managed Kimi Code (OAuth)
  // -------------------------------------------------------------------------
  const managedProvider = config.providers[KIMI_CODE_PROVIDER_NAME];
  if (
    managedProvider !== undefined &&
    managedProvider.type === 'kimi' &&
    managedProvider.oauth !== undefined
  ) {
    try {
      const accessToken = await host.resolveOAuthToken(
        KIMI_CODE_PROVIDER_NAME,
        managedProvider.oauth,
      );
      const models = await fetchManagedKimiCodeModels({
        accessToken,
        baseUrl: managedProvider.baseUrl,
      });
      if (models.length > 0) {
        const beforeIds = collectModelIdsForProvider(config, KIMI_CODE_PROVIDER_NAME);
        const newIds = new Set(models.map((m) => m.id));

        if (setsEqual(beforeIds, newIds)) {
          unchanged.push(KIMI_CODE_PROVIDER_NAME);
        } else {
          const { added, removed } = computeChanges(beforeIds, newIds);
          config = await host.removeProvider(KIMI_CODE_PROVIDER_NAME);
          clearManagedKimiCodeConfig(asManaged(config));
          applyManagedKimiCodeConfig(asManaged(config), {
            models,
            baseUrl: managedProvider.baseUrl,
            preserveDefaultModel: true,
          });
          await host.setConfig({
            providers: config.providers,
            models: config.models,
            defaultModel: config.defaultModel,
            defaultThinking: config.defaultThinking,
          });
          changed.push({
            providerId: KIMI_CODE_PROVIDER_NAME,
            providerName: 'Kimi Code',
            added,
            removed,
          });
        }
      }
    } catch (error) {
      failed.push({
        provider: KIMI_CODE_PROVIDER_NAME,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Open Platforms (moonshot-cn, moonshot-ai, …)
  // -------------------------------------------------------------------------
  const openPlatformIds = Object.keys(config.providers).filter((id) => isOpenPlatformId(id));
  for (const providerId of openPlatformIds) {
    const platform = getOpenPlatformById(providerId);
    if (platform === undefined) continue;

    const providerConfig = config.providers[providerId];
    if (providerConfig === undefined) continue;
    const apiKey = providerConfig.apiKey;
    if (typeof apiKey !== 'string' || apiKey.length === 0) continue;

    try {
      let models = await fetchOpenPlatformModels(platform, apiKey);
      models = filterModelsByPrefix(models, platform);
      if (models.length === 0) continue;

      const beforeIds = collectModelIdsForProvider(config, providerId);
      const newIds = new Set(models.map((m) => m.id));

      if (setsEqual(beforeIds, newIds)) {
        unchanged.push(providerId);
      } else {
        const { added, removed } = computeChanges(beforeIds, newIds);
        const selectedModelId = pickDefaultModel(config, providerId, models);
        const selectedModel = models.find((m) => m.id === selectedModelId);
        if (selectedModel === undefined) continue;

        config = await host.removeProvider(providerId);
        removeOpenPlatformConfig(asManaged(config), providerId);
        applyOpenPlatformConfig(asManaged(config), {
          platform,
          models,
          selectedModel,
          thinking: false,
          apiKey,
        });
        await host.setConfig({
          providers: config.providers,
          models: config.models,
          defaultModel: config.defaultModel,
          defaultThinking: config.defaultThinking,
        });
        changed.push({
          providerId,
          providerName: platform.name,
          added,
          removed,
        });
      }
    } catch (error) {
      failed.push({
        provider: providerId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Custom Registry providers (grouped by {url, apiKey})
  // -------------------------------------------------------------------------
  const customSources = new Map<string, { source: CustomRegistrySource; providerIds: string[] }>();
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    if (providerId === KIMI_CODE_PROVIDER_NAME) continue;
    if (isOpenPlatformId(providerId)) continue;
    const source = readCustomRegistrySource(providerConfig);
    if (source === undefined) continue;
    const key = `${source.url}${source.apiKey}`;
    const entry = customSources.get(key);
    if (entry !== undefined) {
      entry.providerIds.push(providerId);
    } else {
      customSources.set(key, { source, providerIds: [providerId] });
    }
  }

  for (const { source, providerIds } of customSources.values()) {
    try {
      const entries = await fetchCustomRegistry(source);
      let changedAny = false;

      for (const providerId of providerIds) {
        const entry = entries[providerId];
        if (entry === undefined) continue;

        const beforeIds = collectModelIdsForProvider(config, providerId);
        const newIds = new Set(Object.values(entry.models).map((m) => m.id));

        if (setsEqual(beforeIds, newIds)) {
          unchanged.push(providerId);
        } else {
          const { added, removed } = computeChanges(beforeIds, newIds);
          config = await host.removeProvider(providerId);
          removeCustomRegistryProvider(asManaged(config), providerId);
          applyCustomRegistryProvider(asManaged(config), entry, source);
          changedAny = true;
          changed.push({
            providerId,
            providerName: entry.name || providerId,
            added,
            removed,
          });
        }
      }

      if (changedAny) {
        await host.setConfig({
          providers: config.providers,
          models: config.models,
        });
      }
    } catch (error) {
      for (const providerId of providerIds) {
        failed.push({
          provider: providerId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { changed, unchanged, failed };
}
