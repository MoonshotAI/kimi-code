import { createFacadeToken } from '@moonshot-ai/agent-core/kernel/index';
import type { ModelCapability } from '@moonshot-ai/agent-core/llm/request';
import {
  CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
  CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
  capabilitiesFromCustomEntry,
  fetchCustomRegistry,
  type CustomRegistryModelEntry,
  type CustomRegistryProviderEntry,
} from '@moonshot-ai/kimi-code-oauth';

import {
  DEFAULT_MODEL_CONFIG_SECTION,
  MODELS_CONFIG_SECTION,
  PROVIDERS_CONFIG_SECTION,
  isPlainObject,
  omitUndefined,
  type ConfigStore,
  type ModelsSection,
  type ProvidersSection,
} from '#/features/config/index';
import type {
  CatalogModelConfig,
  CatalogModelRecords,
  CatalogProviderInfo,
  ProviderRefreshInput,
  ProviderRefreshReport,
} from '#/features/provider-catalog/index';

import { ModelsDevError } from './errors';
import {
  modelsDevModelToConfig,
  modelsDevProviderModels,
  resolveModelsDevImport,
  toModelsDevProviderItem,
  type ModelsDevProviderItem,
} from './models-dev';
import {
  getModelsDevCatalog,
  modelsDevEntry,
  UPSTREAM_FETCH_TIMEOUT_MS,
} from './upstream';

export const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

export interface ImportModelsDevProviderOptions {
  readonly catalogId: string;
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ModelsDevImportedProvider {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly has_api_key: boolean;
  readonly models: readonly string[];
}

export interface ImportModelsDevProviderResult {
  readonly provider: ModelsDevImportedProvider;
  readonly models_imported: number;
}

export interface ImportCustomRegistryOptions {
  readonly url: string;
  readonly apiKey?: string;
}

export interface ImportCustomRegistryResult {
  readonly providers: readonly ModelsDevImportedProvider[];
  readonly models_imported: number;
}

export interface ModelsDevFace {
  listProviders(): Promise<ModelsDevProviderItem[]>;
  getProvider(catalogId: string): Promise<ModelsDevProviderItem>;
  importProvider(options: ImportModelsDevProviderOptions): Promise<ImportModelsDevProviderResult>;
  importRegistry(options: ImportCustomRegistryOptions): Promise<ImportCustomRegistryResult>;
  refreshRegistries(): Promise<ProviderRefreshReport>;
}

export const ModelsDevRef = createFacadeToken<ModelsDevFace>('models-dev');

export interface ModelsDevService extends ModelsDevFace {
  refreshProvider(input: ProviderRefreshInput): Promise<CatalogModelRecords>;
}

export interface ModelsDevServiceDeps {
  readonly config: () => ConfigStore | undefined;
  readonly userAgent?: string;
  readonly builtinCatalog?: () => unknown;
  readonly refresh: () => Promise<ProviderRefreshReport>;
}

export function createModelsDevService(deps: ModelsDevServiceDeps): ModelsDevService {
  let writeChain: Promise<unknown> = Promise.resolve();

  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const upstreamProps = { userAgent: deps.userAgent, builtinCatalog: deps.builtinCatalog };

  const requireConfig = (): ConfigStore => {
    const config = deps.config();
    if (config === undefined) {
      throw new ModelsDevError(
        'config.unavailable',
        'Cannot import providers: the config feature is not mounted.',
      );
    }
    return config;
  };

  const doImportProvider = async (
    options: ImportModelsDevProviderOptions,
  ): Promise<ImportModelsDevProviderResult> => {
    const { catalogId } = options;
    const catalog = await getModelsDevCatalog(upstreamProps);
    const entry = modelsDevEntry(catalog, catalogId);
    if (entry === undefined) {
      throw new ModelsDevError(
        'modelsDev.catalog_entry_not_found',
        `catalog entry ${catalogId} does not exist`,
      );
    }
    const resolution = resolveModelsDevImport(entry, options.baseUrl);
    if (resolution.kind === 'invalid') {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry ${catalogId} cannot be imported: ${resolution.reason}`,
        { details: { reason: resolution.reason } },
      );
    }
    if (resolution.kind === 'needs-base-url') {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry ${catalogId} requires a base_url`,
      );
    }
    const models = modelsDevProviderModels(entry);
    if (models.length === 0) {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry ${catalogId} has no importable models`,
      );
    }
    const targetId = options.id ?? catalogId;
    if (!PROVIDER_ID_PATTERN.test(targetId)) {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry id ${targetId} cannot be used as a provider id`,
      );
    }
    const config = requireConfig();
    const providers = config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
    const existing = providers[targetId];
    if (existing?.oauth !== undefined) {
      throw new ModelsDevError(
        'provider.oauth_managed',
        `provider ${targetId} is managed by OAuth login`,
      );
    }
    const apiKey = options.apiKey ?? existing?.apiKey;
    await config.set(
      PROVIDERS_CONFIG_SECTION,
      {
        [targetId]: rewrittenProviderInfo({
          type: resolution.wire,
          baseUrl: resolution.baseUrl,
          apiKey,
          source: { kind: 'modelsDev', catalogId },
        }),
      },
      'user',
    );
    const records = config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {};
    const nextModels: Record<string, CatalogModelConfig> = {};
    for (const [key, record] of Object.entries(records)) {
      if (record.provider !== targetId) nextModels[key] = record;
    }
    for (const model of models) {
      nextModels[`${targetId}/${model.id}`] = modelsDevModelToConfig(targetId, model);
    }
    await config.set(MODELS_CONFIG_SECTION, nextModels, 'user');
    const firstModel = models[0];
    if (firstModel !== undefined) {
      await seedDefaultModelWhenUnset(config, `${targetId}/${firstModel.id}`);
    }
    return {
      provider: {
        id: targetId,
        type: resolution.wire,
        base_url: resolution.baseUrl,
        has_api_key: apiKey !== undefined,
        models: models.map((model) => model.id),
      },
      models_imported: models.length,
    };
  };

  const doImportRegistry = async (
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult> => {
    const { url } = options;
    const config = requireConfig();
    const providers = config.get<ProvidersSection>(PROVIDERS_CONFIG_SECTION) ?? {};
    const apiKey = options.apiKey ?? registryKeyFromExisting(providers, url);
    const entries = await fetchRegistry(url, [apiKey ?? '']).catch((error) => {
      throw new ModelsDevError(
        'modelsDev.registry_import_invalid',
        `custom registry at ${url} cannot be imported: ${truncateUpstreamMessage(error)}`,
        { cause: error },
      );
    });
    const entryList = Object.values(entries.entries);
    if (entryList.length === 0) {
      throw new ModelsDevError(
        'modelsDev.registry_import_invalid',
        `custom registry at ${url} has no importable providers`,
      );
    }
    for (const entry of entryList) {
      if (providers[entry.id]?.oauth !== undefined) {
        throw new ModelsDevError(
          'provider.oauth_managed',
          `provider ${entry.id} is managed by OAuth login`,
        );
      }
    }
    const surviving = new Set(entryList.map((entry) => entry.id));
    const nextProviders: Record<string, CatalogProviderInfo> = {};
    for (const [providerId, info] of Object.entries(providers)) {
      if (surviving.has(providerId)) continue;
      if (info?.oauth !== undefined || registrySourceUrl(info) !== url) {
        nextProviders[providerId] = info;
      }
    }
    const nextModels: Record<string, CatalogModelConfig> = {};
    for (const [key, record] of Object.entries(config.get<ModelsSection>(MODELS_CONFIG_SECTION) ?? {})) {
      const provider = record.provider;
      if (provider !== undefined && surviving.has(provider)) continue;
      const info = provider === undefined ? undefined : providers[provider];
      if (registrySourceUrl(info) === url && info?.oauth === undefined) continue;
      nextModels[key] = record;
    }
    for (const entry of entryList) {
      nextProviders[entry.id] = registryProviderInfo(entry, url, apiKey);
      for (const model of Object.values(entry.models)) {
        nextModels[`${entry.id}/${model.id}`] = registryModelToConfig(entry.id, model);
      }
    }
    await writeRegistrySections(config, nextProviders, nextModels);
    const firstEntry = entryList[0];
    const firstModel = firstEntry === undefined ? undefined : Object.values(firstEntry.models)[0];
    if (firstEntry !== undefined && firstModel !== undefined) {
      await seedDefaultModelWhenUnset(config, `${firstEntry.id}/${firstModel.id}`);
    }
    return {
      providers: entryList.map((entry) => ({
        id: entry.id,
        type: entry.type,
        base_url: entry.api,
        has_api_key: apiKey !== undefined && apiKey.length > 0,
        models: Object.values(entry.models).map((model) => model.id),
      })),
      models_imported: entryList.reduce((total, entry) => total + Object.keys(entry.models).length, 0),
    };
  };

  const fetchRegistry = async (
    url: string,
    apiKeys: readonly string[],
  ): Promise<{ entries: Record<string, CustomRegistryProviderEntry>; apiKey: string }> => {
    let lastError: unknown;
    for (const apiKey of apiKeys) {
      try {
        const entries = await fetchCustomRegistry(
          { kind: 'apiJson', url, apiKey },
          { userAgent: deps.userAgent, signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS) },
        );
        return { entries, apiKey };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const doRefreshProvider = async ({
    providerId,
    info,
  }: ProviderRefreshInput): Promise<CatalogModelRecords> => {
    const catalogId = modelsDevSourceCatalogId(info);
    if (catalogId === undefined) {
      throw new Error(`No models.dev refresh source is configured for provider '${providerId}'.`);
    }
    const catalog = await getModelsDevCatalog({ ...upstreamProps, allowFallback: false });
    const entry = modelsDevEntry(catalog, catalogId);
    if (entry === undefined) return {};
    const resolution = resolveModelsDevImport(entry, info.baseUrl);
    if (resolution.kind === 'invalid') {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry ${catalogId} cannot be refreshed: ${resolution.reason}`,
        { details: { reason: resolution.reason } },
      );
    }
    if (resolution.kind === 'needs-base-url') {
      throw new ModelsDevError(
        'modelsDev.import_invalid',
        `catalog entry ${catalogId} requires a base_url`,
      );
    }
    return Object.fromEntries(
      modelsDevProviderModels(entry).map((model) => [
        `${providerId}/${model.id}`,
        modelsDevModelToConfig(providerId, model),
      ]),
    );
  };

  return {
    listProviders: async () => {
      const catalog = await getModelsDevCatalog(upstreamProps);
      return Object.entries(catalog).map(([id, entry]) => toModelsDevProviderItem(id, entry));
    },
    getProvider: async (catalogId) => {
      const catalog = await getModelsDevCatalog(upstreamProps);
      const entry = modelsDevEntry(catalog, catalogId);
      if (entry === undefined) {
        throw new ModelsDevError(
          'modelsDev.catalog_entry_not_found',
          `catalog entry ${catalogId} does not exist`,
        );
      }
      return toModelsDevProviderItem(catalogId, entry);
    },
    importProvider: (options) => enqueueWrite(() => doImportProvider(options)),
    importRegistry: (options) => enqueueWrite(() => doImportRegistry(options)),
    refreshProvider: (input) => enqueueWrite(() => doRefreshProvider(input)),
    refreshRegistries: () => deps.refresh(),
  };
}

function rewrittenProviderInfo(info: {
  readonly type: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly source?: Readonly<Record<string, unknown>>;
}): CatalogProviderInfo {
  return {
    type: info.type,
    baseUrl: info.baseUrl,
    apiKey: info.apiKey,
    customHeaders: undefined,
    defaultModel: undefined,
    oauth: undefined,
    env: undefined,
    modelSource: undefined,
    source: info.source,
  };
}

function registryProviderInfo(
  entry: CustomRegistryProviderEntry,
  url: string,
  apiKey: string | undefined,
): CatalogProviderInfo {
  return omitUndefined({
    type: entry.type,
    baseUrl: entry.api,
    apiKey: apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined,
    source: { kind: 'apiJson', url, apiKey: apiKey ?? '' },
  }) as CatalogProviderInfo;
}

function registrySourceUrl(info: CatalogProviderInfo | undefined): string | undefined {
  const source = info?.source;
  if (!isPlainObject(source)) return undefined;
  if (source['kind'] !== 'apiJson') return undefined;
  const url = source['url'];
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

function modelsDevSourceCatalogId(info: CatalogProviderInfo | undefined): string | undefined {
  const source = info?.source;
  if (!isPlainObject(source)) return undefined;
  if (source['kind'] !== 'modelsDev') return undefined;
  const catalogId = source['catalogId'];
  return typeof catalogId === 'string' && catalogId.length > 0 ? catalogId : undefined;
}

function registryKeyFromExisting(providers: ProvidersSection, url: string): string | undefined {
  for (const info of Object.values(providers)) {
    if (registrySourceUrl(info) !== url) continue;
    const source = info?.source;
    const apiKey = info?.apiKey ?? (isPlainObject(source) ? source['apiKey'] : undefined);
    if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
  }
  return undefined;
}

function registryModelToConfig(
  providerId: string,
  model: CustomRegistryModelEntry,
): CatalogModelConfig {
  const capabilities = hasRegistryCapabilityHints(model)
    ? capabilitiesFromCustomEntry(model)
    : [...CUSTOM_REGISTRY_DEFAULT_CAPABILITIES];
  return omitUndefined({
    provider: providerId,
    model: model.id,
    maxContextSize: registryMaxContextSize(model),
    maxOutputSize: registryMaxOutputSize(model),
    capability: registryCapability(capabilities),
    displayName: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
    supportEfforts: model.support_efforts,
    defaultEffort: model.default_effort,
  }) as CatalogModelConfig;
}

function hasRegistryCapabilityHints(model: CustomRegistryModelEntry): boolean {
  return (
    typeof model.tool_call === 'boolean' ||
    typeof model.reasoning === 'boolean' ||
    model.modalities !== undefined ||
    model.support_efforts !== undefined
  );
}

function registryMaxContextSize(model: CustomRegistryModelEntry): number {
  const context = model.limit?.context;
  if (typeof context === 'number' && Number.isInteger(context) && context > 0) return context;
  const output = model.limit?.output;
  if (typeof output === 'number' && Number.isInteger(output) && output > 0) return output;
  return CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT;
}

function registryMaxOutputSize(model: CustomRegistryModelEntry): number | undefined {
  const output = model.limit?.output;
  return typeof output === 'number' && Number.isInteger(output) && output > 0
    ? output
    : undefined;
}

function registryCapability(capabilities: readonly string[]): ModelCapability {
  return {
    image_in: capabilities.includes('image_in'),
    video_in: capabilities.includes('video_in'),
    audio_in: capabilities.includes('audio_in'),
    thinking: capabilities.includes('thinking'),
    tool_use: capabilities.includes('tool_use'),
  };
}

async function writeRegistrySections(
  config: ConfigStore,
  providers: Record<string, CatalogProviderInfo>,
  models: Record<string, CatalogModelConfig>,
): Promise<void> {
  const currentDefault = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  const clearDefault =
    typeof currentDefault === 'string' &&
    currentDefault.trim() !== '' &&
    models[currentDefault] === undefined;
  await config.replace(
    clearDefault
      ? {
          [PROVIDERS_CONFIG_SECTION]: providers,
          [MODELS_CONFIG_SECTION]: models,
          [DEFAULT_MODEL_CONFIG_SECTION]: undefined,
        }
      : { [PROVIDERS_CONFIG_SECTION]: providers, [MODELS_CONFIG_SECTION]: models },
    'user',
  );
}

async function seedDefaultModelWhenUnset(config: ConfigStore, alias: string): Promise<void> {
  const current = config.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  if (typeof current === 'string' && current.trim() !== '') return;
  await config.set(DEFAULT_MODEL_CONFIG_SECTION, alias, 'user');
}

function truncateUpstreamMessage(error: unknown, limit = 300): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
