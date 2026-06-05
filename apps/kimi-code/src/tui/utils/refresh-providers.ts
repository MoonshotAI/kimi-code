import {
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  applyManagedKimiCodeConfig,
  applyOpenPlatformConfig,
  applyCustomRegistryProvider,
  fetchCustomRegistry,
  fetchManagedKimiCodeModels,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  resolveKimiCodeRuntimeAuth,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import type { KimiConfig, KimiConfigPatch, ModelAlias, OAuthRef, ProviderConfig } from '@moonshot-ai/kimi-code-sdk';

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
  if (typeof url !== 'string' || url.length === 0 || typeof apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url, apiKey };
}

function asManaged(config: KimiConfig): ManagedKimiConfigShape {
  return config as unknown as ManagedKimiConfigShape;
}

function collectModelIdsForAliases(config: KimiConfig, aliasKeys: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = config.models?.[aliasKey];
    if (alias !== undefined && alias.model.length > 0) {
      ids.add(alias.model);
    }
  }
  return ids;
}

function computeChanges(oldIds: Set<string>, newIds: Set<string>): { added: number; removed: number } {
  const count = (ids: Set<string>, other: Set<string>): number =>
    Array.from(ids).filter((id) => !other.has(id)).length;
  return { added: count(newIds, oldIds), removed: count(oldIds, newIds) };
}

interface ProviderModelSnapshot {
  readonly alias: string;
  readonly model: ModelAlias;
}

// Compare the full model metadata for the relevant aliases, not just model IDs:
// a registry can change capabilities (e.g. enabling reasoning) without changing
// any model ID. Spreading the whole `ModelAlias` keeps this in sync with the
// schema automatically; only `capabilities` needs normalizing because its order
// is not meaningful.
function providerModelSnapshot(
  config: KimiConfig,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: ProviderModelSnapshot[] = [];
  for (const alias of aliasKeys) {
    const model = config.models?.[alias];
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      model: {
        ...model,
        capabilities: model.capabilities === undefined ? undefined : model.capabilities.toSorted(),
      },
    });
  }
  snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
  return JSON.stringify(snapshots);
}

function providerModelsEqual(
  config: KimiConfig,
  nextConfig: KimiConfig,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerRefreshAliasKeys(
  config: KimiConfig,
  nextConfig: KimiConfig,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider === providerId && alias.startsWith(aliasPrefix)) keys.add(alias);
  }
  for (const [alias, model] of Object.entries(nextConfig.models ?? {})) {
    if (model.provider === providerId) keys.add(alias);
  }
  return keys;
}

function preserveAndRestoreUserAliases(
  config: KimiConfig,
  next: KimiConfig,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): void {
  const preserved: Record<string, ModelAlias> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(model);
  }
  if (Object.keys(preserved).length === 0) return;
  next.models = { ...next.models, ...preserved };
}

function restoreAndClampDefaults(
  config: KimiConfig,
  defaultModel: string | undefined,
  defaultThinking: boolean | undefined,
): void {
  if (defaultModel !== undefined && config.models?.[defaultModel] !== undefined) {
    config.defaultModel = defaultModel;
    config.defaultThinking = defaultThinking;
  }
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.defaultThinking = undefined;
  }
}

function pickDefaultModel(config: KimiConfig, providerId: string, models: Array<{ id: string }>): string {
  const firstModel = models[0];
  if (firstModel === undefined) return '';

  const existingDefault = config.defaultModel;
  if (existingDefault !== undefined) {
    const alias = config.models?.[existingDefault];
    if (alias !== undefined && alias.provider === providerId) {
      const stillAvailable = models.find((m) => m.id === alias.model);
      if (stillAvailable !== undefined) return stillAvailable.id;
    }
  }
  return firstModel.id;
}

async function refreshSingleProvider(
  host: RefreshProviderHost,
  config: KimiConfig,
  providerId: string,
  providerName: string,
  aliasPrefix: string,
  apply: (next: KimiConfig) => void,
): Promise<{ config: KimiConfig; changed?: ProviderChange }> {
  const next = structuredClone(config);
  apply(next);
  const refreshedAliasKeys = providerRefreshAliasKeys(config, next, providerId, aliasPrefix);
  preserveAndRestoreUserAliases(config, next, providerId, refreshedAliasKeys);
  restoreAndClampDefaults(next, config.defaultModel, config.defaultThinking);

  if (providerModelsEqual(config, next, providerId, refreshedAliasKeys)) {
    return { config };
  }
  const { added, removed } = computeChanges(
    collectModelIdsForAliases(config, refreshedAliasKeys),
    collectModelIdsForAliases(next, refreshedAliasKeys),
  );
  await host.removeProvider(providerId);
  const newConfig = await host.setConfig({
    providers: next.providers,
    models: next.models,
    defaultModel: next.defaultModel,
    defaultThinking: next.defaultThinking,
  });
  return {
    config: newConfig,
    changed: { providerId, providerName, added, removed },
  };
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
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: managedProvider.baseUrl,
        configuredOAuthRef: managedProvider.oauth,
      });
      const accessToken = await host.resolveOAuthToken(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      const models = await fetchManagedKimiCodeModels({ accessToken, baseUrl: auth.baseUrl });
      if (models.length > 0) {
        const result = await refreshSingleProvider(
          host,
          config,
          KIMI_CODE_PROVIDER_NAME,
          'Kimi Code',
          `${KIMI_CODE_PLATFORM_ID}/`,
          (next) =>
            applyManagedKimiCodeConfig(asManaged(next), {
              models,
              baseUrl: auth.baseUrl,
              oauthKey: auth.oauthRef.key,
              oauthHost: auth.oauthRef.oauthHost,
              preserveDefaultModel: true,
            }),
        );
        config = result.config;
        if (result.changed !== undefined) changed.push(result.changed);
        else unchanged.push(KIMI_CODE_PROVIDER_NAME);
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

      const selectedModelId = pickDefaultModel(config, providerId, models);
      const selectedModel = models.find((m) => m.id === selectedModelId);
      if (selectedModel === undefined) continue;
      const result = await refreshSingleProvider(
        host,
        config,
        providerId,
        platform.name,
        `${providerId}/`,
        (next) =>
          applyOpenPlatformConfig(asManaged(next), {
            platform,
            models,
            selectedModel,
            thinking: false,
            apiKey,
          }),
      );
      config = result.config;
      if (result.changed !== undefined) changed.push(result.changed);
      else unchanged.push(providerId);
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
      // Build the whole batch on one clone so that several changed providers
      // from the same source do not overwrite each other's aliases, and so the
      // config we compare is exactly the config we persist.
      const next = structuredClone(config);
      const changedProviders: ProviderChange[] = [];

      for (const providerId of providerIds) {
        const entry = entries[providerId];
        if (entry === undefined) continue;

        applyCustomRegistryProvider(asManaged(next), entry, source);
        const refreshedAliasKeys = providerRefreshAliasKeys(config, next, providerId, `${providerId}/`);
        preserveAndRestoreUserAliases(config, next, providerId, refreshedAliasKeys);

        if (providerModelsEqual(config, next, providerId, refreshedAliasKeys)) {
          unchanged.push(providerId);
        } else {
          const { added, removed } = computeChanges(
            collectModelIdsForAliases(config, refreshedAliasKeys),
            collectModelIdsForAliases(next, refreshedAliasKeys),
          );
          changedProviders.push({ providerId, providerName: entry.name || providerId, added, removed });
        }
      }

      if (changedProviders.length > 0) {
        restoreAndClampDefaults(next, config.defaultModel, config.defaultThinking);
        for (const { providerId } of changedProviders) {
          await host.removeProvider(providerId);
        }
        config = await host.setConfig({
          providers: next.providers,
          models: next.models,
          defaultModel: next.defaultModel,
          defaultThinking: next.defaultThinking,
        });
        for (const change of changedProviders) changed.push(change);
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
