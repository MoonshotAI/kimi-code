/**
 * `kosongConfig` domain — `IModelsDevImportService` implementation.
 *
 * Owns the models.dev directory import and the custom-registry (api.json)
 * import. Both are multi-step config writes (inspect → build → replace × N),
 * serialized through an internal chain so two interleaved imports cannot
 * lose each other's section rebuilds. Custom registries reuse the shared
 * OAuth primitives' exact remove-then-apply sequence, split into TWO
 * persisted passes so deletions really reach the disk (the TOML transform is
 * a raw overlay that only honors entry-level deletes; applying in the same
 * pass would let stale fields of kept ids survive on disk). The in-memory
 * shapes
 * deliberately omit the default pointers so the removal logic can never
 * clamp them: imports never move default_provider/default_model — aside
 * from seeding a default_model from the first imported model when none is
 * configured at all (a fresh setup must become usable).
 *
 * One subtlety shapes all the write code below: the providers/models TOML
 * transforms rebuild each section's entries but overlay each entry's fields
 * onto the old on-disk raw — so an entry id absent from the replacement
 * truly disappears, while a FIELD absent from a kept entry would silently
 * survive on disk (and resurrect on the next boot). Field-level clears
 * therefore always assign an explicit `undefined` (the transform's
 * `setDefined` drops those), and the models.dev import swaps aliases in two
 * passes (drop, then re-add onto clean slots). The kosong persistence
 * bridge then pushes the change into the registries, which is also what
 * invalidates the runtime model catalog.
 *
 * Both third-party fetches — the models.dev directory and the custom-registry
 * import — send the identity snapshot's `outboundUserAgent`, matching what
 * the scheduled refresh of the same registry sends: these are directories
 * this service chooses to call, so a header is always sent.
 */

import {
  applyCustomRegistryProvider,
  fetchCustomRegistry,
  removeCustomRegistryProvider,
  type CustomRegistryProviderEntry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import { type ModelsSection } from '#/kosong/model/model';
import { type ProviderConfig, type ProvidersSection } from '#/kosong/provider/provider';
import { modelsDevProviderModels, resolveModelsDevImport } from './modelsDev';

import { DEFAULT_MODEL_SECTION, MODELS_SECTION, PROVIDERS_SECTION } from './configSection';
import { ModelsDevImportErrors } from './errors';
import { IKosongConfigService } from './kosongConfig';
import {
  IModelsDevImportService,
  PROVIDER_ID_PATTERN,
  type ImportCustomRegistryOptions,
  type ImportCustomRegistryResult,
  type ImportModelsDevProviderOptions,
  type ImportModelsDevProviderResult,
  type ModelsDevProviderItem,
} from './modelsDevImport';
import {
  getModelsDevCatalog,
  modelsDevEntry,
  modelsDevModelToRecord,
  toModelsDevProviderItem,
  upstreamFetch,
  UPSTREAM_FETCH_TIMEOUT_MS,
} from './modelsDevUpstream';

const codes = ModelsDevImportErrors.codes;

export class ModelsDevImportService implements IModelsDevImportService {
  declare readonly _serviceBrand: undefined;

  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IKosongConfigService private readonly kosongConfig: IKosongConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  private async outboundUserAgent(): Promise<string> {
    return (await this.identity.resolved()).outboundUserAgent;
  }

  async listModelsDevProviders(): Promise<ModelsDevProviderItem[]> {
    const catalog = await getModelsDevCatalog(await this.outboundUserAgent());
    return Object.entries(catalog).map(([id, entry]) => toModelsDevProviderItem(id, entry));
  }

  async getModelsDevProvider(catalogId: string): Promise<ModelsDevProviderItem> {
    const catalog = await getModelsDevCatalog(await this.outboundUserAgent());
    const entry = modelsDevEntry(catalog, catalogId);
    if (entry === undefined) {
      throw new Error2(
        codes.CATALOG_ENTRY_NOT_FOUND,
        `catalog entry ${catalogId} does not exist`,
      );
    }
    return toModelsDevProviderItem(catalogId, entry);
  }

  importModelsDevProvider(
    options: ImportModelsDevProviderOptions,
  ): Promise<ImportModelsDevProviderResult> {
    return this.enqueueWrite(() => this.doImportModelsDevProvider(options));
  }

  importCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult> {
    return this.enqueueWrite(() => this.doImportCustomRegistry(options));
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readyConfig(): Promise<IConfigService> {
    await this.config.ready;
    await this.kosongConfig.ready;
    return this.config;
  }

  private async doImportModelsDevProvider(
    options: ImportModelsDevProviderOptions,
  ): Promise<ImportModelsDevProviderResult> {
    const { catalogId } = options;
    const catalog = await getModelsDevCatalog(await this.outboundUserAgent());
    const entry = modelsDevEntry(catalog, catalogId);
    if (entry === undefined) {
      throw new Error2(
        codes.CATALOG_ENTRY_NOT_FOUND,
        `catalog entry ${catalogId} does not exist`,
      );
    }

    const resolution = resolveModelsDevImport(entry, options.baseUrl);
    if (resolution.kind === 'invalid') {
      throw new Error2(
        codes.CATALOG_IMPORT_INVALID,
        `catalog entry ${catalogId} cannot be imported: ${resolution.reason}`,
      );
    }
    if (resolution.kind === 'needs-base-url') {
      throw new Error2(
        codes.CATALOG_IMPORT_INVALID,
        `catalog entry ${catalogId} requires a base_url`,
      );
    }

    const models = modelsDevProviderModels(entry);
    if (models.length === 0) {
      throw new Error2(
        codes.CATALOG_IMPORT_INVALID,
        `catalog entry ${catalogId} has no importable models`,
      );
    }

    const targetId = options.id ?? catalogId;
    if (!PROVIDER_ID_PATTERN.test(targetId)) {
      throw new Error2(
        codes.CATALOG_IMPORT_INVALID,
        `catalog entry id ${targetId} cannot be used as a provider id`,
      );
    }

    const config = await this.readyConfig();
    const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    const existing = providers[targetId];
    if (existing?.oauth !== undefined) {
      throw new Error2(
        codes.PROVIDER_OAUTH_MANAGED,
        `provider ${targetId} is managed by OAuth login; use POST /oauth/logout instead`,
      );
    }

    const provider: ProviderConfig = { type: resolution.wire };
    provider.baseUrl = resolution.baseUrl;
    provider.apiKey = options.apiKey ?? existing?.apiKey;
    await config.replace(PROVIDERS_SECTION, { ...providers, [targetId]: provider });

    const records = config.inspect<ModelsSection>(MODELS_SECTION).userValue ?? {};
    const withoutTarget = Object.fromEntries(
      Object.entries(records).filter(([, record]) => record.provider !== targetId),
    );
    await config.replace(MODELS_SECTION, withoutTarget);
    const nextModels = { ...withoutTarget };
    for (const model of models) {
      nextModels[`${targetId}/${model.id}`] = modelsDevModelToRecord(targetId, model);
    }
    await config.replace(MODELS_SECTION, nextModels);

    const firstModel = models[0];
    if (firstModel !== undefined) {
      await seedDefaultModelWhenUnset(config, `${targetId}/${firstModel.id}`);
    }

    const imported = await this.modelCatalog.getProvider(targetId);
    return { provider: imported, modelsImported: models.length };
  }

  private async doImportCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult> {
    const { url } = options;
    const config = await this.readyConfig();
    const providers = config.inspect<ProvidersSection>(PROVIDERS_SECTION).userValue ?? {};
    const source: CustomRegistrySource = {
      kind: 'apiJson',
      url,
      apiKey: options.apiKey ?? registryKeyFromExisting(providers, url) ?? '',
    };

    let entries: Record<string, CustomRegistryProviderEntry>;
    try {
      entries = await fetchCustomRegistry(source, {
        fetchImpl: upstreamFetch(),
        userAgent: await this.outboundUserAgent(),
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error2(
        codes.REGISTRY_IMPORT_INVALID,
        `custom registry at ${url} cannot be imported: ${truncateUpstreamMessage(err)}`,
      );
    }
    if (Object.keys(entries).length === 0) {
      throw new Error2(
        codes.REGISTRY_IMPORT_INVALID,
        `custom registry at ${url} has no importable providers`,
      );
    }

    for (const entry of Object.values(entries)) {
      if (providers[entry.id]?.oauth !== undefined) {
        throw new Error2(
          codes.PROVIDER_OAUTH_MANAGED,
          `provider ${entry.id} is managed by OAuth login; use POST /oauth/logout instead`,
        );
      }
    }

    const removed = {
      providers: { ...providers },
      models: {
        ...config.inspect<ModelsSection>(MODELS_SECTION).userValue,
      },
    } as ManagedKimiConfigShape;
    const surviving = new Set(Object.values(entries).map((entry) => entry.id));
    for (const [providerId, provider] of Object.entries(removed.providers)) {
      if (surviving.has(providerId)) continue;
      if (!isRecord(provider)) continue;
      if (provider['oauth'] !== undefined) continue;
      const existingSource = provider['source'];
      if (
        isRecord(existingSource) &&
        existingSource['kind'] === 'apiJson' &&
        existingSource['url'] === url
      ) {
        removeCustomRegistryProvider(removed, providerId);
      }
    }
    for (const entry of Object.values(entries)) {
      if (entry.id in removed.providers) {
        removeCustomRegistryProvider(removed, entry.id);
      }
    }
    await config.replace(PROVIDERS_SECTION, removed.providers as ProvidersSection);
    await config.replace(MODELS_SECTION, (removed.models ?? {}) as ModelsSection);

    const applied = {
      providers: removed.providers,
      models: removed.models,
    } as ManagedKimiConfigShape;
    for (const entry of Object.values(entries)) {
      applyCustomRegistryProvider(applied, entry, source);
    }
    await config.replace(PROVIDERS_SECTION, applied.providers as ProvidersSection);
    await config.replace(MODELS_SECTION, (applied.models ?? {}) as ModelsSection);

    const firstEntry = Object.values(entries)[0];
    const firstModelKey = firstEntry === undefined ? undefined : Object.keys(firstEntry.models)[0];
    if (firstEntry !== undefined && firstModelKey !== undefined) {
      await seedDefaultModelWhenUnset(config, `${firstEntry.id}/${firstModelKey}`);
    }

    const imported = [];
    for (const entry of Object.values(entries)) {
      imported.push(await this.modelCatalog.getProvider(entry.id));
    }
    const modelsImported = Object.values(entries).reduce(
      (total, entry) => total + Object.keys(entry.models).length,
      0,
    );
    return { providers: imported, modelsImported };
  }
}

async function seedDefaultModelWhenUnset(config: IConfigService, alias: string): Promise<void> {
  const current = config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
  if (current !== undefined && current.trim() !== '') return;
  await config.replace(DEFAULT_MODEL_SECTION, alias);
}

function registryKeyFromExisting(
  providers: ProvidersSection,
  url: string,
): string | undefined {
  for (const provider of Object.values(providers)) {
    if (!isRecord(provider)) continue;
    const source = provider['source'];
    if (isRecord(source) && source['kind'] === 'apiJson' && source['url'] === url) {
      const key = source['apiKey'];
      if (typeof key === 'string' && key.length > 0) return key;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateUpstreamMessage(err: unknown, limit = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

registerScopedService(
  LifecycleScope.App,
  IModelsDevImportService,
  ModelsDevImportService,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
