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
  removeCustomRegistryProvider,
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

export type RefreshProviderScope = 'all' | 'oauth';

export interface RefreshProviderOptions {
  readonly scope?: RefreshProviderScope;
}

function readCustomRegistrySource(provider: ProviderConfig): CustomRegistrySource | undefined {
  const source = provider.source;
  if (typeof source !== 'object' || source === null) return undefined;
  const candidate = source;
  if (candidate['kind'] !== 'apiJson') return undefined;
  const url = candidate['url'];
  const apiKey = candidate['apiKey'];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  if (typeof apiKey !== 'string') return undefined;
  return { kind: 'apiJson', url, apiKey };
}

function customRegistrySourceKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url]);
}

function customRegistrySourceCredentialKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url, source.apiKey]);
}

async function fetchCustomRegistryFromSources(
  sources: readonly CustomRegistrySource[],
): Promise<{
  readonly entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  readonly source: CustomRegistrySource;
}> {
  let lastError: unknown;
  for (const source of sources) {
    try {
      return {
        entries: await fetchCustomRegistry(source),
        source,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  if (typeof lastError === 'string') throw new Error(lastError);
  throw new Error('No custom registry sources configured.');
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

function providerConfigSnapshot(config: KimiConfig, providerId: string): string {
  return JSON.stringify(config.providers[providerId] ?? null);
}

function providerConfigEqual(config: KimiConfig, nextConfig: KimiConfig, providerId: string): boolean {
  return providerConfigSnapshot(config, providerId) === providerConfigSnapshot(nextConfig, providerId);
}

function providerRefreshAliasKeys(
  config: KimiConfig,
  nextConfig: KimiConfig,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
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
  // A refresh may have just learned that the default model cannot disable
  // thinking — never restore a stale thinking-off selection onto it.
  const capabilities = config.models[defaultModel]?.capabilities ?? [];
  config.defaultThinking = capabilities.includes('always_thinking') ? true : defaultThinking;
}

// `apply*` may leave `defaultModel` pointing at an alias that no longer exists
// (e.g. the previously-selected model was dropped from the registry). The host's
// `setConfig` deep-merge cannot clear a key, so the matching `removeProvider`
// call handles disk cleanup while this drops the dangling reference in memory.
function clampDanglingDefault(config: KimiConfig): void {
  if (config.defaultModel !== undefined && config.models?.[config.defaultModel] === undefined) {
    config.defaultModel = undefined;
    config.defaultThinking = undefined;
  }
}

function clearDefaultThinkingWhenDefaultRemoved(
  config: KimiConfig,
  previousDefaultModel: string | undefined,
): void {
  if (previousDefaultModel !== undefined && config.defaultModel === undefined) {
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
      if (stillAvailable !== undefined) {
        return stillAvailable.id;
      }
    }
  }
  return firstModel.id;
}

export async function refreshAllProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  const changed: ProviderChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ provider: string; reason: string }> = [];
  const scope = options.scope ?? 'all';

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
        const next = structuredClone(config);
        applyManagedKimiCodeConfig(asManaged(next), {
          models,
          baseUrl: auth.baseUrl,
          oauthKey: auth.oauthRef.key,
          oauthHost: auth.oauthRef.oauthHost,
          preserveDefaultModel: true,
        });
        const refreshedAliasKeys = providerRefreshAliasKeys(
          config,
          next,
          KIMI_CODE_PROVIDER_NAME,
          `${KIMI_CODE_PLATFORM_ID}/`,
        );
        restoreProviderAliases(
          next,
          preserveUserProviderAliases(config, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys),
        );
        restoreDefaultSelection(next, config.defaultModel, config.defaultThinking);
        clampDanglingDefault(next);
        clearDefaultThinkingWhenDefaultRemoved(next, config.defaultModel);

        if (providerModelsEqual(config, next, KIMI_CODE_PROVIDER_NAME, refreshedAliasKeys)) {
          unchanged.push(KIMI_CODE_PROVIDER_NAME);
        } else {
          const { added, removed } = computeChanges(
            collectModelIdsForAliases(config, refreshedAliasKeys),
            collectModelIdsForAliases(next, refreshedAliasKeys),
          );
          await host.removeProvider(KIMI_CODE_PROVIDER_NAME);
          config = await host.setConfig({
            providers: next.providers,
            models: next.models,
            defaultModel: next.defaultModel,
            defaultThinking: next.defaultThinking,
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

  if (scope === 'oauth') {
    return { changed, unchanged, failed };
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
      const next = structuredClone(config);
      applyOpenPlatformConfig(asManaged(next), {
        platform,
        models,
        selectedModel,
        thinking: false,
        apiKey,
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        config,
        next,
        providerId,
        `${providerId}/`,
      );
      restoreProviderAliases(next, preserveUserProviderAliases(config, providerId, refreshedAliasKeys));
      restoreDefaultSelection(next, config.defaultModel, config.defaultThinking);
      clampDanglingDefault(next);
      clearDefaultThinkingWhenDefaultRemoved(next, config.defaultModel);

      if (providerModelsEqual(config, next, providerId, refreshedAliasKeys)) {
        unchanged.push(providerId);
      } else {
        const { added, removed } = computeChanges(
          collectModelIdsForAliases(config, refreshedAliasKeys),
          collectModelIdsForAliases(next, refreshedAliasKeys),
        );
        await host.removeProvider(providerId);
        config = await host.setConfig({
          providers: next.providers,
          models: next.models,
          defaultModel: next.defaultModel,
          defaultThinking: next.defaultThinking,
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
  // 3. Custom Registry providers (grouped by URL, with API-key candidates)
  // -------------------------------------------------------------------------
  const customSources = new Map<
    string,
    {
      readonly sources: CustomRegistrySource[];
      readonly sourceKeys: Set<string>;
      readonly providerIds: string[];
    }
  >();
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    if (providerId === KIMI_CODE_PROVIDER_NAME) continue;
    if (isOpenPlatformId(providerId)) continue;
    const source = readCustomRegistrySource(providerConfig);
    if (source === undefined) continue;
    const key = customRegistrySourceKey(source);
    const sourceKey = customRegistrySourceCredentialKey(source);
    const entry = customSources.get(key);
    if (entry !== undefined) {
      if (!entry.sourceKeys.has(sourceKey)) {
        entry.sources.push(source);
        entry.sourceKeys.add(sourceKey);
      }
      entry.providerIds.push(providerId);
    } else {
      customSources.set(key, {
        sources: [source],
        sourceKeys: new Set([sourceKey]),
        providerIds: [providerId],
      });
    }
  }

  for (const { sources, providerIds } of customSources.values()) {
    try {
      const { entries, source } = await fetchCustomRegistryFromSources(sources);
      // Build the whole batch on one clone so that several changed providers
      // from the same source do not overwrite each other's aliases, and so the
      // config we compare is exactly the config we persist.
      const next = structuredClone(config);
      const changedProviders: Array<{
        readonly providerId: string;
        readonly providerName: string;
        readonly added: number;
        readonly removed: number;
      }> = [];
      const providersToRemoveBeforeSet = new Set<string>();
      let hasUnreportedConfigChange = false;
      const remoteEntries = Object.values(entries);
      const remoteEntriesByProviderId = new Map(
        remoteEntries.map((entry) => [entry.id, entry]),
      );
      const providerIdsToSync = new Set(providerIds);
      for (const entry of remoteEntries) providerIdsToSync.add(entry.id);

      for (const providerId of providerIdsToSync) {
        const entry = remoteEntriesByProviderId.get(providerId);
        if (entry === undefined) {
          const oldIds = collectModelIdsForAliases(config, providerAliasKeys(config, providerId));
          removeCustomRegistryProvider(asManaged(next), providerId);
          changedProviders.push({
            providerId,
            providerName: providerId,
            added: 0,
            removed: oldIds.size,
          });
          providersToRemoveBeforeSet.add(providerId);
          continue;
        }

        const existed = config.providers[providerId] !== undefined;
        applyCustomRegistryProvider(asManaged(next), entry, source);
        const refreshedAliasKeys = providerRefreshAliasKeys(config, next, providerId, `${providerId}/`);
        if (existed) {
          restoreProviderAliases(next, preserveUserProviderAliases(config, providerId, refreshedAliasKeys));
        }

        if (
          existed &&
          providerModelsEqual(config, next, providerId, refreshedAliasKeys) &&
          providerConfigEqual(config, next, providerId)
        ) {
          unchanged.push(providerId);
        } else if (existed && providerModelsEqual(config, next, providerId, refreshedAliasKeys)) {
          unchanged.push(providerId);
          providersToRemoveBeforeSet.add(providerId);
          hasUnreportedConfigChange = true;
        } else {
          const { added, removed } = computeChanges(
            collectModelIdsForAliases(config, refreshedAliasKeys),
            collectModelIdsForAliases(next, refreshedAliasKeys),
          );
          changedProviders.push({
            providerId,
            providerName: entry.name || providerId,
            added,
            removed,
          });
          if (existed) providersToRemoveBeforeSet.add(providerId);
        }
      }

      if (changedProviders.length > 0 || hasUnreportedConfigChange) {
        restoreDefaultSelection(next, config.defaultModel, config.defaultThinking);
        clampDanglingDefault(next);
        clearDefaultThinkingWhenDefaultRemoved(next, config.defaultModel);
        for (const providerId of providersToRemoveBeforeSet) {
          await host.removeProvider(providerId);
        }
        config = await host.setConfig({
          providers: next.providers,
          models: next.models,
          defaultModel: next.defaultModel,
          defaultThinking: next.defaultThinking,
        });
        for (const change of changedProviders) {
          changed.push({
            providerId: change.providerId,
            providerName: change.providerName,
            added: change.added,
            removed: change.removed,
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
