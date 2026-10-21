import { createCollection, useContribute, type RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import {
  isManagedKimiCodeBaseUrl,
  isOpenPlatformId,
  KIMI_CODE_PROVIDER_NAME,
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';

import {
  DEFAULT_MODEL_CONFIG_SECTION,
  DEFAULT_PROVIDER_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  THINKING_CONFIG_SECTION,
  capabilityFromArray,
  deepEqual,
  isPlainObject,
  type ConfigStore,
  type ModelsSection,
  type ProvidersSection,
  type ThinkingConfig,
} from '#/features/config/index';

import { ModelCatalogError } from './binding';
import {
  type CatalogModelConfig,
  type CatalogModelRecords,
  type CatalogOAuthRef,
  type CatalogProviderInfo,
  type ProviderRefreshContribution,
} from './types';

export interface ProviderRefreshChange {
  readonly provider_id: string;
  readonly provider_name: string;
  readonly added: number;
  readonly removed: number;
}

export interface ProviderRefreshFailure {
  readonly provider: string;
  readonly reason: string;
}

export interface RetiredDefault {
  readonly from: string;
  readonly to: string;
  readonly from_display_name: string;
}

export interface ProviderRefreshReport {
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
  readonly retired_default?: RetiredDefault;
}

export interface ProviderRefreshOptions {
  readonly providerId?: string;
  readonly scope?: 'all' | 'oauth';
}

export interface RetiredModel {
  readonly from: string;
  readonly to: string;
}

export interface ModelCatalogChangedEvent extends RuntimeEvent {
  readonly type: 'event.model_catalog.changed';
  readonly payload: ProviderRefreshReport;
}

export interface ProviderOAuthTokenResolver {
  resolve(providerName: string, ref: CatalogOAuthRef | undefined): Promise<string>;
}

export const ProviderOAuthTokenResolvers = createCollection<ProviderOAuthTokenResolver>(
  'provider-catalog.oauth-token-resolvers',
);

export function useProviderOAuthTokenResolver(
  contribution: ProviderOAuthTokenResolver,
  priority = 0,
): void {
  useContribute(ProviderOAuthTokenResolvers, contribution, priority);
}

export const ProviderRefreshUserAgents = createCollection<string>('provider-catalog.refresh-user-agents');

export function useProviderRefreshUserAgent(userAgent: string | undefined): void {
  if (userAgent !== undefined) useContribute(ProviderRefreshUserAgents, userAgent);
}

interface RefreshOrchestratorDeps {
  readonly config: () => ConfigStore | undefined;
  readonly providerIds: () => readonly string[];
  readonly providerInfo: (providerId: string) => CatalogProviderInfo | undefined;
  readonly refreshers: () => readonly ProviderRefreshContribution[];
  readonly tokenResolvers: () => readonly ProviderOAuthTokenResolver[];
  readonly userAgents: () => readonly string[];
  readonly onChanged: (report: ProviderRefreshReport) => void;
  readonly onFailed: (providerId: string, error: unknown) => void;
  readonly onRetired: (event: RetiredModel) => void;
}

interface StaticExclusion {
  readonly providers: Record<string, CatalogProviderInfo>;
  readonly models: Record<string, CatalogModelConfig>;
  readonly defaultModel?: string;
  readonly thinking?: ThinkingConfig;
}

const EMPTY_EXCLUSION: StaticExclusion = { providers: {}, models: {} };

const CAPABILITY_KEYS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const;

const REFRESH_REMOTE_FIELDS = new Set([
  'provider',
  'model',
  'maxContextSize',
  'capability',
  'displayName',
  'supportEfforts',
  'defaultEffort',
  'upgrade',
]);

function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  excluded: Readonly<Record<string, unknown>>,
): Record<string, T> {
  if (Object.keys(excluded).length === 0) return { ...record };
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key in excluded)));
}

function replaceKey(
  record: Record<string, unknown>,
  source: string,
  target: string,
  value: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(record)) {
    if (key === source) {
      out[target] = value;
    } else {
      out[key] = current;
    }
  }
  if (!(source in record)) out[target] = value;
  return out;
}

const MANAGED_MODEL_KEY_ORDER = [
  'provider',
  'model',
  'maxContextSize',
  'capabilities',
  'displayName',
  'supportEfforts',
  'defaultEffort',
  'protocol',
  'betaApi',
  'adaptiveThinking',
  'upgrade',
] as const;

const MANAGED_MODEL_KEY_SET: ReadonlySet<string> = new Set(MANAGED_MODEL_KEY_ORDER);

function orderManagedModel(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'overrides' && !MANAGED_MODEL_KEY_SET.has(key)) {
      out[key] = value;
    }
  }
  for (const key of MANAGED_MODEL_KEY_ORDER) {
    if (key in record) out[key] = record[key];
  }
  if ('overrides' in record) out['overrides'] = record['overrides'];
  return out;
}

function toManagedModel(record: CatalogModelConfig): Record<string, unknown> {
  let out: Record<string, unknown> = { ...record };
  const capabilities: string[] = CAPABILITY_KEYS.filter((key) => record.capability?.[key] === true);
  if (record.alwaysThinking === true) capabilities.push('always_thinking');
  const unknowns = record.extras?.['capabilities'];
  if (Array.isArray(unknowns)) capabilities.push(...unknowns.map(String));
  if (record.capability !== undefined || unknowns !== undefined || record.alwaysThinking === true) {
    out = replaceKey(out, 'capability', 'capabilities', capabilities);
  }
  if (isPlainObject(record.overrides)) {
    let overrides = { ...record.overrides };
    if (overrides['capability'] !== undefined || overrides['alwaysThinking'] === true) {
      const overrideCapabilities: string[] = CAPABILITY_KEYS.filter(
        (key) => isPlainObject(overrides['capability']) && overrides['capability'][key] === true,
      );
      if (overrides['alwaysThinking'] === true) overrideCapabilities.push('always_thinking');
      overrides = replaceKey(overrides, 'capability', 'capabilities', overrideCapabilities);
    }
    out['overrides'] = overrides;
  }
  if (record.extras !== undefined) {
    const extras = { ...record.extras };
    delete extras['capabilities'];
    if (Object.keys(extras).length === 0) {
      delete out['extras'];
    } else {
      out['extras'] = extras;
    }
  }
  return orderManagedModel(out);
}

function fromManagedModel(record: Record<string, unknown>): CatalogModelConfig {
  let out = { ...record };
  const rawCapabilities = out['capabilities'];
  if (Array.isArray(rawCapabilities)) {
    const { capability, unknowns, alwaysThinking } = capabilityFromArray(rawCapabilities);
    out = replaceKey(out, 'capabilities', 'capability', capability);
    if (alwaysThinking) out['alwaysThinking'] = true;
    if (unknowns.length > 0) {
      out['extras'] = { ...(isPlainObject(out['extras']) ? out['extras'] : {}), capabilities: unknowns };
    }
  }
  const overrides = out['overrides'];
  if (isPlainObject(overrides) && Array.isArray(overrides['capabilities'])) {
    const { capability, alwaysThinking } = capabilityFromArray(overrides['capabilities']);
    const nextOverrides = replaceKey(overrides, 'capabilities', 'capability', capability);
    if (alwaysThinking) nextOverrides['alwaysThinking'] = true;
    out['overrides'] = nextOverrides;
  }
  return out as CatalogModelConfig;
}

function toManagedModels(
  models: Readonly<Record<string, CatalogModelConfig>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, record]) => [alias, toManagedModel(record)]),
  );
}

function fromManagedModels(models: Readonly<Record<string, unknown>>): Record<string, CatalogModelConfig> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, record]) => [
      alias,
      fromManagedModel(isPlainObject(record) ? record : {}),
    ]),
  );
}

function readUserShape(config: ConfigStore, exclusion: StaticExclusion = EMPTY_EXCLUSION): ManagedKimiConfigShape {
  const providers = config.inspect<ProvidersSection>(PROVIDERS_CONFIG_SECTION).userValue ?? {};
  const models = config.inspect<ModelsSection>(MODELS_CONFIG_SECTION).userValue ?? {};
  const defaultProvider = config.inspect<string>(DEFAULT_PROVIDER_CONFIG_SECTION).userValue;
  const defaultModel = config.inspect<string>(DEFAULT_MODEL_CONFIG_SECTION).userValue;
  const thinking = config.inspect<ThinkingConfig>(THINKING_CONFIG_SECTION).userValue;
  const visible = withoutKeys(models, exclusion.models);
  const managedModels = toManagedModels(visible);
  const excludedDefaultRecord =
    exclusion.defaultModel === undefined ? undefined : models[exclusion.defaultModel];
  if (exclusion.defaultModel !== undefined && excludedDefaultRecord !== undefined) {
    managedModels[exclusion.defaultModel] = toManagedModel(excludedDefaultRecord);
  }
  return {
    providers: withoutKeys(providers, exclusion.providers),
    models: managedModels,
    defaultModel,
    defaultProvider,
    thinking: thinking === undefined ? undefined : { ...thinking },
  } as ManagedKimiConfigShape;
}

function computeStaticExclusion(config: ConfigStore): StaticExclusion {
  const providers = config.inspect<ProvidersSection>(PROVIDERS_CONFIG_SECTION).userValue ?? {};
  const staticIds = Object.entries(providers)
    .filter(([, info]) => info?.modelSource === 'static')
    .map(([providerId]) => providerId);
  if (staticIds.length === 0) return EMPTY_EXCLUSION;
  const excludedProviders = Object.fromEntries(
    staticIds.map((providerId) => [providerId, providers[providerId]]),
  ) as Record<string, CatalogProviderInfo>;
  const models = config.inspect<ModelsSection>(MODELS_CONFIG_SECTION).userValue ?? {};
  const excludedModels = Object.fromEntries(
    Object.entries(models).filter(([, record]) => record.provider !== undefined && record.provider in excludedProviders),
  );
  const defaultModel = config.inspect<string>(DEFAULT_MODEL_CONFIG_SECTION).userValue;
  return {
    providers: excludedProviders,
    models: excludedModels,
    defaultModel: defaultModel !== undefined && defaultModel in excludedModels ? defaultModel : undefined,
    thinking:
      defaultModel !== undefined && defaultModel in excludedModels
        ? config.inspect<ThinkingConfig>(THINKING_CONFIG_SECTION).userValue
        : undefined,
  };
}

function mergeRefreshedModelAlias(
  existing: CatalogModelConfig | undefined,
  remote: CatalogModelConfig,
): CatalogModelConfig {
  const current = existing ?? {};
  const extras = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== 'overrides' && !REFRESH_REMOTE_FIELDS.has(key)),
  );
  return {
    ...extras,
    ...remote,
    ...(current.overrides === undefined ? {} : { overrides: current.overrides }),
  } as CatalogModelConfig;
}

function mergeRefreshedModels(
  providerId: string,
  current: Readonly<Record<string, CatalogModelConfig>>,
  refreshed: CatalogModelRecords,
): Record<string, CatalogModelConfig> {
  const prefix = `${providerId}/`;
  const remoteEntries = Object.entries(refreshed).filter(([key]) => key.startsWith(prefix));
  if (remoteEntries.length === 0) return { ...current };
  const next = { ...current };
  for (const [key, record] of Object.entries(current)) {
    if (key.startsWith(prefix) && record.provider === providerId) delete next[key];
  }
  for (const [key, record] of remoteEntries) {
    next[key] = mergeRefreshedModelAlias(current[key], record);
  }
  return next;
}

function providerAliasKeys(
  models: Readonly<Record<string, CatalogModelConfig>>,
  providerId: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [alias, record] of Object.entries(models)) {
    if (record.provider === providerId) keys.add(alias);
  }
  return keys;
}

function refreshAliasKeys(
  current: Readonly<Record<string, CatalogModelConfig>>,
  next: Readonly<Record<string, CatalogModelConfig>>,
  providerId: string,
): Set<string> {
  const prefix = `${providerId}/`;
  const keys = new Set<string>();
  for (const [alias, record] of Object.entries(current)) {
    if (record.provider === providerId && alias.startsWith(prefix)) keys.add(alias);
  }
  for (const key of providerAliasKeys(next, providerId)) keys.add(key);
  return keys;
}

function modelIds(
  models: Readonly<Record<string, CatalogModelConfig>>,
  aliases: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const alias of aliases) {
    const record = models[alias];
    if (record !== undefined) ids.add(record.model ?? alias);
  }
  return ids;
}

function changes(before: ReadonlySet<string>, after: ReadonlySet<string>): { added: number; removed: number } {
  return {
    added: [...after].filter((id) => !before.has(id)).length,
    removed: [...before].filter((id) => !after.has(id)).length,
  };
}

function modelsEqual(
  current: Readonly<Record<string, CatalogModelConfig>>,
  next: Readonly<Record<string, CatalogModelConfig>>,
  providerId: string,
  aliases: ReadonlySet<string>,
  defaultModel: string | undefined,
): boolean {
  const snapshot = (models: Readonly<Record<string, CatalogModelConfig>>) =>
    Object.fromEntries(
      [...aliases].toSorted().map((alias) => [alias, models[alias]]),
    );
  return deepEqual(
    { defaultModel: defaultModel ?? null, models: snapshot(current) },
    { defaultModel: defaultModel ?? null, models: snapshot(next) },
  );
}

function apiJsonSource(info: CatalogProviderInfo | undefined): { readonly url: string; readonly apiKey: string } | undefined {
  const source = info?.source;
  if (!isPlainObject(source) || source['kind'] !== 'apiJson') return undefined;
  const url = source['url'];
  const apiKey = source['apiKey'];
  if (typeof url !== 'string' || typeof apiKey !== 'string') return undefined;
  return { url, apiKey };
}

function orchestratorOwns(providerId: string, info: CatalogProviderInfo | undefined): boolean {
  if (info === undefined) return false;
  if (providerId === KIMI_CODE_PROVIDER_NAME && info.type === 'kimi' && info.oauth !== undefined) {
    return true;
  }
  const registry = apiJsonSource(info);
  if (registry !== undefined) return true;
  if (isOpenPlatformId(providerId)) return true;
  return (
    info.type === 'kimi' &&
    info.oauth === undefined &&
    isManagedKimiCodeBaseUrl(info.baseUrl)
  );
}

async function discoverProviderModels(
  providerId: string,
  info: CatalogProviderInfo,
): Promise<CatalogModelRecords> {
  const baseUrl = info.baseUrl;
  if (baseUrl === undefined) throw new Error(`model discovery for '${providerId}' requires a baseUrl`);
  const headers: Record<string, string> = { ...info.customHeaders };
  if (info.apiKey !== undefined) headers['authorization'] = `Bearer ${info.apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
  if (!response.ok) throw new Error(`model discovery failed for '${baseUrl}': HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isPlainObject(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`model discovery for '${providerId}' returned an unexpected payload shape`);
  }
  const records: Record<string, CatalogModelConfig> = {};
  for (const item of payload['data']) {
    if (!isPlainObject(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
      throw new Error(`model discovery for '${providerId}' returned an invalid model entry`);
    }
    records[`${providerId}/${item['id']}`] = { provider: providerId, model: item['id'] };
  }
  return records;
}

function mergeResults(current: RefreshResult, next: RefreshResult): RefreshResult {
  return {
    changed: [...current.changed, ...next.changed],
    unchanged: [...current.unchanged, ...next.unchanged],
    failed: [...current.failed, ...next.failed],
    retiredDefault: current.retiredDefault ?? next.retiredDefault,
  };
}

function publicReport(result: RefreshResult): ProviderRefreshReport {
  const retired = result.retiredDefault;
  const fromModel = retired?.fromModel as Record<string, unknown> | undefined;
  const overrides = isPlainObject(fromModel?.['overrides']) ? fromModel['overrides'] : undefined;
  const fromDisplayName =
    overrides?.['displayName'] ?? fromModel?.['displayName'] ?? fromModel?.['model'] ?? retired?.from;
  return {
    changed: result.changed.map((change) => ({
      provider_id: change.providerId,
      provider_name: change.providerName,
      added: change.added,
      removed: change.removed,
    })),
    unchanged: [...result.unchanged],
    failed: result.failed.map((failure) => ({ ...failure })),
    retired_default:
      retired === undefined || typeof fromDisplayName !== 'string'
        ? undefined
        : { from: retired.from, to: retired.to, from_display_name: fromDisplayName },
  };
}

export function createRefreshOrchestrator(deps: RefreshOrchestratorDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const retiredModels = new Map<string, string>();

  const requireConfig = (): ConfigStore => {
    const config = deps.config();
    if (config === undefined) {
      throw new ModelCatalogError(
        'config.unavailable',
        'Cannot refresh catalog models: the config feature is not mounted.',
      );
    }
    return config;
  };

  const finalize = (result: RefreshResult): ProviderRefreshReport => {
    for (const failure of result.failed) deps.onFailed(failure.provider, new Error(failure.reason));
    const retired = result.retiredDefault;
    if (retired !== undefined) {
      for (const [alias, replacement] of retiredModels) {
        if (replacement === retired.from) retiredModels.set(alias, retired.to);
      }
      retiredModels.set(retired.from, retired.to);
      deps.onRetired({ from: retired.from, to: retired.to });
    }
    const report = publicReport(result);
    if (report.changed.length > 0) deps.onChanged(report);
    return report;
  };

  const refreshCustom = async (
    config: ConfigStore,
    providerId: string,
    info: CatalogProviderInfo,
  ): Promise<RefreshResult> => {
    const contribution = deps.refreshers().findLast((candidate) => candidate.match(info));
    if (contribution === undefined && info.modelSource !== 'discover') {
      return {
        changed: [],
        unchanged: [],
        failed: [{ provider: providerId, reason: `No refresh channel is available for provider '${providerId}'.` }],
      };
    }
    try {
      const refreshed =
        contribution === undefined
          ? await discoverProviderModels(providerId, info)
          : await contribution.refresh({ providerId, info });
      const current = config.inspect<ModelsSection>(MODELS_CONFIG_SECTION).userValue ?? {};
      const next = mergeRefreshedModels(providerId, current, refreshed);
      const aliases = refreshAliasKeys(current, next, providerId);
      const defaultModel = config.inspect<string>(DEFAULT_MODEL_CONFIG_SECTION).userValue;
      const { added, removed } = changes(modelIds(current, aliases), modelIds(next, aliases));
      if (added === 0 && removed === 0 && modelsEqual(current, next, providerId, aliases, defaultModel)) {
        return { changed: [], unchanged: [providerId], failed: [] };
      }
      await config.replace({ [MODELS_CONFIG_SECTION]: next }, 'user');
      return {
        changed: [{ providerId, providerName: providerId, added, removed }],
        unchanged: [],
        failed: [],
      };
    } catch (error) {
      return {
        changed: [],
        unchanged: [],
        failed: [{ provider: providerId, reason: error instanceof Error ? error.message : String(error) }],
      };
    }
  };

  const run = async (options: ProviderRefreshOptions): Promise<ProviderRefreshReport> => {
    const config = requireConfig();
    await config.reload();
    const providerId = options.providerId;
    const userProviders = config.inspect<ProvidersSection>(PROVIDERS_CONFIG_SECTION).userValue ?? {};
    const scopedInfo =
      providerId === undefined
        ? undefined
        : (userProviders[providerId] ?? deps.providerInfo(providerId));
    if (providerId !== undefined && scopedInfo === undefined && !deps.providerIds().includes(providerId)) {
      throw new ModelCatalogError('provider.not_found', `provider ${providerId} does not exist`);
    }
    if (providerId !== undefined && scopedInfo?.modelSource === 'static') {
      return { changed: [], unchanged: [providerId], failed: [] };
    }

    const exclusion = computeStaticExclusion(config);
    const host: RefreshProviderHost = {
      getConfig: () => Promise.resolve(readUserShape(config, exclusion)),
      removeProvider: (id) => {
        const current = readUserShape(config);
        const providers = { ...(current.providers as Record<string, unknown>) };
        delete providers[id];
        const models = Object.fromEntries(
          Object.entries(current.models ?? {}).filter(([, record]) =>
            isPlainObject(record) ? record['provider'] !== id : true,
          ),
        );
        return Promise.resolve({ ...current, providers, models } as ManagedKimiConfigShape);
      },
      setConfig: async (patch) => {
        const sections: Record<string, unknown> = {};
        if (patch.providers !== undefined) {
          sections[PROVIDERS_CONFIG_SECTION] = { ...exclusion.providers, ...patch.providers };
        }
        if (patch.models !== undefined) {
          const excludedModels = toManagedModels(exclusion.models);
          sections[MODELS_CONFIG_SECTION] = fromManagedModels({
            ...excludedModels,
            ...patch.models,
          });
        }
        if ('defaultModel' in patch) {
          sections[DEFAULT_MODEL_CONFIG_SECTION] =
            exclusion.defaultModel === undefined ? patch.defaultModel : exclusion.defaultModel;
        }
        if ('thinking' in patch) {
          sections[THINKING_CONFIG_SECTION] =
            exclusion.defaultModel === undefined ? patch.thinking : exclusion.thinking;
        }
        if ('defaultProvider' in patch) {
          sections[DEFAULT_PROVIDER_CONFIG_SECTION] = patch['defaultProvider'];
        }
        await config.replace(sections, 'user');
        return readUserShape(config, exclusion);
      },
      resolveOAuthToken: async (providerName, ref?: ManagedKimiOAuthRef) => {
        const resolver = deps.tokenResolvers().findLast(() => true);
        if (resolver === undefined) throw new Error('OAuth token provider is not configured.');
        return resolver.resolve(providerName, ref);
      },
      userAgent: deps.userAgents().at(-1),
    };
    let result = await refreshProviderModels(host, options);
    if ((options.scope ?? 'all') === 'oauth') return finalize(result);

    if (providerId !== undefined) {
      if (!orchestratorOwns(providerId, scopedInfo)) {
        result = mergeResults(result, await refreshCustom(config, providerId, scopedInfo ?? {}));
      }
      return finalize(result);
    }

    const providers: Record<string, CatalogProviderInfo | undefined> = { ...userProviders };
    for (const id of deps.providerIds()) {
      if (providers[id] === undefined) providers[id] = deps.providerInfo(id);
    }
    const staticIds = Object.entries(providers)
      .filter(([, info]) => info?.modelSource === 'static')
      .map(([id]) => id);
    if (staticIds.length > 0) {
      result = mergeResults(result, { changed: [], unchanged: staticIds, failed: [] });
    }
    for (const [id, info] of Object.entries(providers)) {
      if (info === undefined || info.modelSource === 'static' || orchestratorOwns(id, info)) continue;
      const hasCustom =
        deps.refreshers().some((candidate) => candidate.match(info)) || info.modelSource === 'discover';
      if (!hasCustom) continue;
      result = mergeResults(result, await refreshCustom(config, id, info));
    }
    return finalize(result);
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const pending = chain.then(task);
    chain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    addModel: (key: string, record: CatalogModelConfig): Promise<void> =>
      enqueue(async () => {
        const config = requireConfig();
        const models = config.inspect<ModelsSection>(MODELS_CONFIG_SECTION).userValue ?? {};
        await config.set(MODELS_CONFIG_SECTION, { ...models, [key]: record }, 'user');
      }),
    refresh: (options: ProviderRefreshOptions = {}): Promise<ProviderRefreshReport> =>
      enqueue(() => run(options)),
    retiredModelReplacement: (alias: string): string | undefined => {
      const config = deps.config();
      if (config === undefined) return undefined;
      const models = config.inspect<ModelsSection>(MODELS_CONFIG_SECTION).userValue ?? {};
      if (alias in models) return undefined;
      const seen = new Set<string>([alias]);
      let current = alias;
      while (retiredModels.has(current)) {
        const next = retiredModels.get(current)!;
        if (next in models) return next;
        if (seen.has(next)) return undefined;
        seen.add(next);
        current = next;
      }
      return undefined;
    },
  };
}
