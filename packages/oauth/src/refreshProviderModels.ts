import {
  applyCustomRegistryProvider,
  declaredUpgradeTarget,
  fetchCustomRegistry,
  isReservedProviderId,
  oauthManagedProviderMessage,
  readCustomRegistrySource,
  removeCustomRegistryProvider,
  reservedProviderIdMessage,
  type CustomRegistrySource,
} from './custom-registry';
import {
  applyManagedApiKeyProviderModels,
  applyManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeRuntimeAuth,
  type ManagedKimiConfigShape,
  type ManagedKimiModelAlias,
  type ManagedKimiOAuthRef,
} from './managed-kimi-code';
import { isManagedKimiCodeBaseUrl } from './managed-usage';
import {
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
} from './open-platform';
import {
  declaredProviderCredential,
  apiKeyEnvMissingMessage,
  credentialConflictMessage,
  nonEmptyString,
} from './provider-credential';
import { isRecord } from './utils';

export interface RefreshProviderHost {
  getConfig(): Promise<ManagedKimiConfigShape>;
  removeProvider(providerId: string): Promise<ManagedKimiConfigShape>;
  setConfig(patch: ManagedKimiConfigShape): Promise<ManagedKimiConfigShape>;
  resolveOAuthToken(providerName: string, oauthRef?: ManagedKimiOAuthRef): Promise<string>;
  readonly userAgent?: string;
}

export interface ProviderChange {
  readonly providerId: string;
  readonly providerName: string;
  readonly added: number;
  readonly removed: number;
}

export interface RefreshResult {
  readonly changed: readonly ProviderChange[];
  readonly unchanged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly provider: string; readonly reason: string }>;
  readonly retiredDefault?: {
    readonly from: string;
    readonly to: string;
    readonly fromModel: ManagedKimiModelAlias;
  };
}

export type RefreshProviderScope = 'all' | 'oauth';

export interface RefreshProviderOptions {
  readonly scope?: RefreshProviderScope;
  readonly providerId?: string;
}

interface ProviderView {
  readonly type?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: unknown;
  readonly oauth?: ManagedKimiOAuthRef;
  readonly source?: unknown;
  readonly env?: unknown;
}

function resolveProviderApiKey(provider: ProviderView, providerName: string): string | undefined {
  const declared = declaredProviderCredential(provider, providerName);
  if (declared.kind === 'conflict') {
    throw new Error(declared.message);
  }
  if (declared.kind === 'inline') {
    return declared.apiKey;
  }
  if (declared.kind === 'env') {
    const value = nonEmptyString(process.env[declared.apiKeyEnv]);
    if (value === undefined) {
      throw new Error(apiKeyEnvMissingMessage(providerName, declared.apiKeyEnv));
    }
    return value;
  }
  if (isRecord(provider.env)) {
    const fromEnv = nonEmptyString(provider.env['KIMI_API_KEY']);
    if (fromEnv !== undefined) {
      if (provider.oauth !== undefined) {
        throw new Error(credentialConflictMessage('Provider', providerName, 'apiKey', 'oauth'));
      }
      return fromEnv;
    }
  }
  return undefined;
}

function readProvider(
  config: ManagedKimiConfigShape,
  providerId: string,
): ProviderView | undefined {
  const provider = config.providers[providerId];
  if (provider === undefined) return undefined;
  return provider as ProviderView;
}

function readModel(
  config: ManagedKimiConfigShape,
  alias: string,
): ManagedKimiModelAlias | undefined {
  const model = config.models?.[alias];
  if (model === undefined) return undefined;
  return model as ManagedKimiModelAlias;
}

function customRegistrySourceKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url]);
}

function customRegistrySourceCredentialKey(source: CustomRegistrySource): string {
  return JSON.stringify([source.url, source.apiKey]);
}

async function fetchCustomRegistryFromSources(
  sources: readonly CustomRegistrySource[],
  userAgent?: string,
): Promise<{
  readonly entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  readonly source: CustomRegistrySource;
}> {
  let lastError: unknown;
  for (const source of sources) {
    try {
      return {
        entries: await fetchCustomRegistry(source, { userAgent }),
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

function collectModelIdsForAliases(
  config: ManagedKimiConfigShape,
  aliasKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const aliasKey of aliasKeys) {
    const alias = readModel(config, aliasKey);
    if (alias !== undefined && alias.model.length > 0) {
      ids.add(alias.model);
    }
  }
  return ids;
}

function providerAliasKeys(config: ManagedKimiConfigShape, providerId: string): Set<string> {
  const keys = new Set<string>();
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    if ((raw as ManagedKimiModelAlias).provider === providerId) keys.add(alias);
  }
  return keys;
}

function generatedProviderAliasKeys(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    const model = raw as ManagedKimiModelAlias;
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
  readonly model: ManagedKimiModelAlias;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeysDeep(value[key])]),
  );
}

function providerModelSnapshot(
  config: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): string {
  const snapshots: ProviderModelSnapshot[] = [];
  for (const alias of aliasKeys) {
    const model = readModel(config, alias);
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
  return JSON.stringify(sortKeysDeep({ defaultModel: config.defaultModel ?? null, models: snapshots }));
}

function providerModelsEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasKeys: ReadonlySet<string>,
): boolean {
  return (
    providerModelSnapshot(config, providerId, aliasKeys) ===
    providerModelSnapshot(nextConfig, providerId, aliasKeys)
  );
}

function providerConfigSnapshot(config: ManagedKimiConfigShape, providerId: string): string {
  return JSON.stringify(sortKeysDeep(config.providers[providerId] ?? null));
}

function providerConfigEqual(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
): boolean {
  return providerConfigSnapshot(config, providerId) === providerConfigSnapshot(nextConfig, providerId);
}

function providerRefreshAliasKeys(
  config: ManagedKimiConfigShape,
  nextConfig: ManagedKimiConfigShape,
  providerId: string,
  aliasPrefix: string,
): Set<string> {
  const keys = generatedProviderAliasKeys(config, providerId, aliasPrefix);
  for (const key of providerAliasKeys(nextConfig, providerId)) keys.add(key);
  return keys;
}

function preserveUserProviderAliases(
  config: ManagedKimiConfigShape,
  providerId: string,
  refreshedAliasKeys: ReadonlySet<string>,
): Record<string, ManagedKimiModelAlias> {
  const preserved: Record<string, ManagedKimiModelAlias> = {};
  for (const [alias, raw] of Object.entries(config.models ?? {})) {
    const model = raw as ManagedKimiModelAlias;
    if (model.provider !== providerId || refreshedAliasKeys.has(alias)) continue;
    preserved[alias] = structuredClone(model);
  }
  return preserved;
}

function restoreProviderAliases(
  config: ManagedKimiConfigShape,
  aliases: Record<string, ManagedKimiModelAlias>,
): void {
  if (Object.keys(aliases).length === 0) return;
  config.models = {
    ...config.models,
    ...aliases,
  };
}

function restoreDefaultSelection(
  config: ManagedKimiConfigShape,
  defaultModel: string | undefined,
  defaultEnabled: boolean | undefined,
): void {
  if (defaultModel === undefined || readModel(config, defaultModel) === undefined) return;
  config.defaultModel = defaultModel;
  const capabilities = readModel(config, defaultModel)?.capabilities ?? [];
  const enabled = capabilities.includes('always_thinking') ? true : defaultEnabled;
  if (enabled !== undefined) {
    config.thinking = { ...config.thinking, enabled };
  }
}

async function rebaseSelectionAfterFetch(
  host: RefreshProviderHost,
  config: ManagedKimiConfigShape,
): Promise<ManagedKimiConfigShape> {
  const fresh = await host.getConfig();
  return { ...config, defaultModel: fresh.defaultModel, thinking: fresh.thinking };
}

function followRetiredDefault(
  previous: ManagedKimiConfigShape,
  next: ManagedKimiConfigShape,
): RefreshResult['retiredDefault'] {
  const from = previous.defaultModel;
  if (from === undefined || readModel(next, from) !== undefined) return undefined;
  const fromModel = readModel(previous, from);
  const to = declaredUpgradeTarget(previous, from);
  if (fromModel === undefined || to === undefined || readModel(next, to) === undefined) {
    return undefined;
  }
  restoreDefaultSelection(next, to, previous.thinking?.enabled);
  return { from, to, fromModel };
}

function clampDanglingDefault(config: ManagedKimiConfigShape): void {
  if (config.defaultModel !== undefined && readModel(config, config.defaultModel) === undefined) {
    config.defaultModel = undefined;
    config.thinking = undefined;
  }
}

function clearDefaultThinkingWhenDefaultRemoved(
  config: ManagedKimiConfigShape,
  previousDefaultModel: string | undefined,
): void {
  if (previousDefaultModel !== undefined && config.defaultModel === undefined) {
    config.thinking = undefined;
  }
}

function pickDefaultModel(
  config: ManagedKimiConfigShape,
  providerId: string,
  models: Array<{ id: string }>,
): string {
  const firstModel = models[0];
  if (firstModel === undefined) return '';

  const existingDefault = config.defaultModel;
  if (existingDefault !== undefined) {
    const alias = readModel(config, existingDefault);
    if (alias !== undefined && alias.provider === providerId) {
      const stillAvailable = models.find((m) => m.id === alias.model);
      if (stillAvailable !== undefined) {
        return stillAvailable.id;
      }
    }
  }
  return firstModel.id;
}

export async function refreshProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  const changed: ProviderChange[] = [];
  const unchanged: string[] = [];
  const failed: Array<{ provider: string; reason: string }> = [];
  let retiredDefault: RefreshResult['retiredDefault'];
  const scope = options.scope ?? 'all';
  const targetId = options.providerId;

  let config = await host.getConfig();

  const managedProvider = readProvider(config, KIMI_CODE_PROVIDER_NAME);
  const managedWanted = targetId === undefined || targetId === KIMI_CODE_PROVIDER_NAME;
  if (
    managedWanted &&
    managedProvider !== undefined &&
    managedProvider.type === 'kimi' &&
    managedProvider.oauth !== undefined
  ) {
    try {
      const declared = declaredProviderCredential(managedProvider, KIMI_CODE_PROVIDER_NAME);
      if (declared.kind === 'conflict') {
        throw new Error(declared.message);
      }
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
        config = await rebaseSelectionAfterFetch(host, config);
        const next = structuredClone(config);
        applyManagedKimiCodeConfig(next, {
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
        restoreDefaultSelection(next, config.defaultModel, config.thinking?.enabled);
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
            thinking: next.thinking,
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

  const openPlatformIds = Object.keys(config.providers).filter((id) => {
    if (!isOpenPlatformId(id)) return false;
    const provider = readProvider(config, id);
    return provider !== undefined && readCustomRegistrySource(provider) === undefined;
  });
  for (const providerId of openPlatformIds) {
    if (targetId !== undefined && targetId !== providerId) continue;
    const platform = getOpenPlatformById(providerId);
    if (platform === undefined) continue;

    const providerConfig = readProvider(config, providerId);
    if (providerConfig === undefined) continue;

    try {
      const declared = declaredProviderCredential(providerConfig, providerId);
      const apiKey = resolveProviderApiKey(providerConfig, providerId);
      if (apiKey === undefined) continue;
      let models = await fetchOpenPlatformModels(platform, apiKey);
      models = filterModelsByPrefix(models, platform);
      if (models.length === 0) continue;

      config = await rebaseSelectionAfterFetch(host, config);
      const selectedModelId = pickDefaultModel(config, providerId, models);
      const selectedModel = models.find((m) => m.id === selectedModelId);
      if (selectedModel === undefined) continue;
      const next = structuredClone(config);
      applyOpenPlatformConfig(next, {
        platform,
        models,
        selectedModel,
        thinking: false,
        credential: declared.kind === 'env' ? { apiKeyEnv: declared.apiKeyEnv } : { apiKey },
      });
      const refreshedAliasKeys = providerRefreshAliasKeys(
        config,
        next,
        providerId,
        `${providerId}/`,
      );
      restoreProviderAliases(next, preserveUserProviderAliases(config, providerId, refreshedAliasKeys));
      restoreDefaultSelection(next, config.defaultModel, config.thinking?.enabled);
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
          thinking: next.thinking,
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

  for (const providerId of Object.keys(config.providers)) {
    if (isOpenPlatformId(providerId)) continue;
    if (targetId !== undefined && targetId !== providerId) continue;
    const provider = readProvider(config, providerId);
    if (provider === undefined) continue;
    if (provider.type !== 'kimi') continue;
    const earlyDeclared = declaredProviderCredential(provider, providerId);
    if (earlyDeclared.kind === 'conflict') {
      if (providerId !== KIMI_CODE_PROVIDER_NAME || provider.oauth === undefined) {
        failed.push({ provider: providerId, reason: earlyDeclared.message });
      }
      continue;
    }
    if (provider.oauth !== undefined) continue;
    if (readCustomRegistrySource(provider) !== undefined) continue;
    if (!isManagedKimiCodeBaseUrl(provider.baseUrl)) continue;

    try {
      const apiKey = resolveProviderApiKey(provider, providerId);
      if (apiKey === undefined) continue;
      const models = await fetchManagedKimiCodeModels({
        accessToken: apiKey,
        baseUrl: provider.baseUrl,
        credentialKind: 'apiKey',
      });
      if (models.length === 0) continue;

      config = await rebaseSelectionAfterFetch(host, config);
      const aliasPrefix =
        providerId === KIMI_CODE_PROVIDER_NAME ? `${KIMI_CODE_PLATFORM_ID}/` : `${providerId}/`;
      const next = structuredClone(config);
      applyManagedApiKeyProviderModels(next, providerId, models, aliasPrefix);
      const refreshedAliasKeys = providerRefreshAliasKeys(config, next, providerId, aliasPrefix);
      restoreProviderAliases(
        next,
        preserveUserProviderAliases(config, providerId, refreshedAliasKeys),
      );
      restoreDefaultSelection(next, config.defaultModel, config.thinking?.enabled);
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
          thinking: next.thinking,
          defaultProvider: next['defaultProvider'],
        });
        changed.push({
          providerId,
          providerName: providerId,
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

  const customSources = new Map<
    string,
    {
      readonly sources: CustomRegistrySource[];
      readonly sourceKeys: Set<string>;
      readonly providerIds: string[];
    }
  >();
  for (const providerId of Object.keys(config.providers)) {
    const provider = readProvider(config, providerId);
    if (provider === undefined) continue;
    if (provider.oauth !== undefined) continue;
    const source = readCustomRegistrySource(provider);
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
    if (targetId !== undefined && !providerIds.includes(targetId)) continue;
    try {
      const { entries, source } = await fetchCustomRegistryFromSources(sources, host.userAgent);
      if (Object.keys(entries).length === 0) {
        throw new Error(`Custom registry at ${source.url} contained no usable providers.`);
      }
      config = await rebaseSelectionAfterFetch(host, config);
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
      const rejectedProviderIds = new Set<string>();
      if (targetId === undefined) {
        for (const entry of remoteEntries) {
          if (isReservedProviderId(entry.id)) {
            rejectedProviderIds.add(entry.id);
            failed.push({
              provider: entry.id,
              reason: reservedProviderIdMessage(entry.id),
            });
            continue;
          }
          const existing = readProvider(config, entry.id);
          if (existing?.oauth !== undefined) {
            rejectedProviderIds.add(entry.id);
            failed.push({
              provider: entry.id,
              reason: oauthManagedProviderMessage(entry.id),
            });
            continue;
          }
          providerIdsToSync.add(entry.id);
        }
      }

      for (const providerId of providerIdsToSync) {
        if (rejectedProviderIds.has(providerId)) continue;
        if (targetId !== undefined && providerId !== targetId) continue;
        const entry = remoteEntriesByProviderId.get(providerId);
        if (entry === undefined) {
          if (isReservedProviderId(providerId)) {
            failed.push({
              provider: providerId,
              reason: reservedProviderIdMessage(providerId),
            });
            continue;
          }
          const oldIds = collectModelIdsForAliases(config, providerAliasKeys(config, providerId));
          removeCustomRegistryProvider(next, providerId);
          changedProviders.push({
            providerId,
            providerName: providerId,
            added: 0,
            removed: oldIds.size,
          });
          providersToRemoveBeforeSet.add(providerId);
          continue;
        }

        const existingProvider = readProvider(config, providerId);
        if (existingProvider?.oauth !== undefined) {
          failed.push({
            provider: providerId,
            reason: oauthManagedProviderMessage(providerId),
          });
          continue;
        }
        const declared = declaredProviderCredential(existingProvider ?? {}, providerId);
        if (declared.kind === 'conflict') {
          failed.push({ provider: providerId, reason: declared.message });
          continue;
        }
        const existed = existingProvider !== undefined;
        try {
          applyCustomRegistryProvider(next, entry, source);
        } catch (error) {
          failed.push({
            provider: providerId,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
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
        restoreDefaultSelection(next, config.defaultModel, config.thinking?.enabled);
        const retired = followRetiredDefault(config, next);
        clampDanglingDefault(next);
        clearDefaultThinkingWhenDefaultRemoved(next, config.defaultModel);
        for (const providerId of providersToRemoveBeforeSet) {
          await host.removeProvider(providerId);
        }
        config = await host.setConfig({
          providers: next.providers,
          models: next.models,
          defaultModel: next.defaultModel,
          thinking: next.thinking,
        });
        retiredDefault = retired ?? retiredDefault;
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
      const reportedIds = targetId !== undefined ? [targetId] : providerIds;
      for (const providerId of reportedIds) {
        failed.push({
          provider: providerId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { changed, unchanged, failed, retiredDefault };
}
