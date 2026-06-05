import {
  KIMI_CODE_PLATFORM_ID,
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
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (typeof apiKey !== 'string') return undefined;
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

function providerAliasKeys(config: KimiConfig, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: KimiConfig,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider === providerId && alias.startsWith(aliasPrefix)) {
      keys.add(alias);
    }
  }
  return keys;
}

function unionSets<T>(...sets: ReadonlyArray<ReadonlySet<T>>): Set<T> {
  const out = new Set<T>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
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

interface ProviderModelSnapshot {
  readonly alias: string;
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly adaptiveThinking?: boolean;
}

function providerModelSnapshots(
  config: KimiConfig,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): ProviderModelSnapshot[] {
  const snapshots: ProviderModelSnapshot[] = [];
  for (const alias of aliasKeys) {
    const model = config.models?.[alias];
    if (model === undefined || model.provider !== providerId) continue;
    snapshots.push({
      alias,
      provider: model.provider,
      model: model.model,
      maxContextSize: model.maxContextSize,
      maxOutputSize: model.maxOutputSize,
      capabilities: model.capabilities === undefined ? undefined : [...model.capabilities].sort(),
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      adaptiveThinking: model.adaptiveThinking,
    });
  }
  return snapshots.sort((a, b) => a.alias.localeCompare(b.alias));
}

function providerModelsEqual(
  config: KimiConfig,
  nextConfig: KimiConfig,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    JSON.stringify(providerModelSnapshots(config, providerId, aliasKeys)) ===
    JSON.stringify(providerModelSnapshots(nextConfig, providerId, aliasKeys))
  );
}

function providerRefreshAliasKeys(
  config: KimiConfig,
  nextConfig: KimiConfig,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  return unionSets(
    generatedProviderAliasKeys(config, providerId, aliasPrefix),
    providerAliasKeys(nextConfig, providerId),
  );
}

function preserveUserProviderAliases(
  config: KimiConfig,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ModelAlias> {
  const preserved: Record<string, ModelAlias> = {};
  for (const [alias, model] of Object.entries(config.models ?? {})) {
    if (model.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(model);
  }
  return preserved;
}

function restoreProviderAliases(config: KimiConfig, aliases: Record<string, ModelAlias>): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  };
}

function restoreDefaultSelection(
  config: KimiConfig,
  defaultModel: string | undefined,
  defaultThinking: boolean | undefined,
): void {
  if (defaultModel === undefined || config.models?.[defaultModel] === undefined) return;
  config.defaultModel = defaultModel;
  config.defaultThinking = defaultThinking;
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
      const auth = resolveKimiCodeRuntimeAuth({
        configuredBaseUrl: managedProvider.baseUrl,
        configuredOAuthRef: managedProvider.oauth,
      });
      const accessToken = await host.resolveOAuthToken(KIMI_CODE_PROVIDER_NAME, auth.oauthRef);
      const models = await fetchManagedKimiCodeModels({
        accessToken,
        baseUrl: auth.baseUrl,
      });
      if (models.length > 0) {
        const nextConfig = structuredClone(config);
        applyManagedKimiCodeConfig(asManaged(nextConfig), {
          models,
          baseUrl: auth.baseUrl,
          oauthKey: auth.oauthRef.key,
          oauthHost: auth.oauthRef.oauthHost,
          preserveDefaultModel: true,
        });
        const refreshedAliasKeys = providerRefreshAliasKeys(
          config,
          nextConfig,
          KIMI_CODE_PROVIDER_NAME,
          `${KIMI_CODE_PLATFORM_ID}/`,
        );
        const beforeIds = collectModelIdsForAliases(config, refreshedAliasKeys);
        const newIds = collectModelIdsForAliases(nextConfig, refreshedAliasKeys);

        if (providerModelsEqual(config, nextConfig, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
          unchanged.push(KIMI_CODE_PROVIDER_NAME);
        } else {
          const { added, removed } = computeChanges(beforeIds, newIds);
          const previousDefaultModel = config.defaultModel;
          const previousDefaultThinking = config.defaultThinking;
          const userAliases = preserveUserProviderAliases(
            config,
            KIMI_CODE_PROVIDER_NAME,
            refreshedAliasKeys,
          );
          config = await host.removeProvider(KIMI_CODE_PROVIDER_NAME);
          clearManagedKimiCodeConfig(asManaged(config));
          applyManagedKimiCodeConfig(asManaged(config), {
            models,
            baseUrl: auth.baseUrl,
            oauthKey: auth.oauthRef.key,
            oauthHost: auth.oauthRef.oauthHost,
            preserveDefaultModel: true,
          });
          restoreProviderAliases(config, userAliases);
          restoreDefaultSelection(config, previousDefaultModel, previousDefaultThinking);
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

      const selectedModelId = pickDefaultModel(config, providerId, models);
      const selectedModel = models.find((m) => m.id === selectedModelId);
      if (selectedModel === undefined) continue;
      const nextConfig = structuredClone(config);
      applyOpenPlatformConfig(asManaged(nextConfig), {
        platform,
        models,
        selectedModel,
        thinking: false,
        apiKey,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        config,
        nextConfig,
        providerId,
        `${providerId}/`,
      );
      const beforeIds = collectModelIdsForAliases(config, refreshedAliasKeys);
      const newIds = collectModelIdsForAliases(nextConfig, refreshedAliasKeys);

      if (providerModelsEqual(config, nextConfig, providerId, refreshedAliasKeys)) {
        unchanged.push(providerId);
      } else {
        const { added, removed } = computeChanges(beforeIds, newIds);
        const previousDefaultModel = config.defaultModel;
        const previousDefaultThinking = config.defaultThinking;
        const userAliases = preserveUserProviderAliases(config, providerId, refreshedAliasKeys);

        config = await host.removeProvider(providerId);
        removeOpenPlatformConfig(asManaged(config), providerId);
        applyOpenPlatformConfig(asManaged(config), {
          platform,
          models,
          selectedModel,
          thinking: false,
          apiKey,
        });
        restoreProviderAliases(config, userAliases);
        restoreDefaultSelection(config, previousDefaultModel, previousDefaultThinking);
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
      const changedProviders: Array<{
        readonly providerId: string;
        readonly entry: NonNullable<(typeof entries)[string]>;
        readonly userAliases: Record<string, ModelAlias>;
        readonly added: number;
        readonly removed: number;
      }> = [];

      for (const providerId of providerIds) {
        const entry = entries[providerId];
        if (entry === undefined) continue;

        const nextConfig = structuredClone(config);
        applyCustomRegistryProvider(asManaged(nextConfig), entry, source);
        const refreshedAliasKeys = providerRefreshAliasKeys(
          config,
          nextConfig,
          providerId,
          `${providerId}/`,
        );
        const beforeIds = collectModelIdsForAliases(config, refreshedAliasKeys);
        const newIds = collectModelIdsForAliases(nextConfig, refreshedAliasKeys);

        if (providerModelsEqual(config, nextConfig, providerId, refreshedAliasKeys)) {
          unchanged.push(providerId);
        } else {
          const { added, removed } = computeChanges(beforeIds, newIds);
          changedProviders.push({
            providerId,
            entry,
            userAliases: preserveUserProviderAliases(config, providerId, refreshedAliasKeys),
            added,
            removed,
          });
        }
      }

      if (changedProviders.length > 0) {
        const previousDefaultModel = config.defaultModel;
        const previousDefaultThinking = config.defaultThinking;
        for (const { providerId } of changedProviders) {
          config = await host.removeProvider(providerId);
          removeCustomRegistryProvider(asManaged(config), providerId);
        }
        for (const { entry } of changedProviders) {
          applyCustomRegistryProvider(asManaged(config), entry, source);
        }
        for (const { userAliases } of changedProviders) {
          restoreProviderAliases(config, userAliases);
        }
        restoreDefaultSelection(config, previousDefaultModel, previousDefaultThinking);
        await host.setConfig({
          providers: config.providers,
          models: config.models,
          defaultModel: config.defaultModel,
          defaultThinking: config.defaultThinking,
        });
        for (const { providerId, entry, added, removed } of changedProviders) {
          changed.push({
            providerId,
            providerName: entry.name || providerId,
            added,
            removed,
          });
        }
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
