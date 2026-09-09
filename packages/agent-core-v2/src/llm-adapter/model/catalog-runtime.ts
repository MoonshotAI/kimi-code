import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  createProviderCatalogSync,
  type CatalogModel,
  type CatalogModelDefinition,
  type CatalogModelOverrides,
  type CatalogProviderInfo,
  type ProviderCatalog,
  type ProviderCatalogChanged,
} from '#human/llm/provider-catalog';
import type { ModelCapability } from '#human/llm/capability';

import { deepEqual } from '../record-diff';
import { IProviderService, type ProviderConfig } from '../provider/provider';

import { IModelService, type ModelOverride, type ModelRecord } from './model';
import { deriveProviderId, nonEmpty } from './model-auth';

interface CatalogModelExtras {
  readonly record: ModelRecord;
}

interface DesiredBucket {
  readonly info?: CatalogProviderInfo;
  readonly models: readonly CatalogModelDefinition[];
}

export interface IProviderCatalogRuntime {
  readonly _serviceBrand: undefined;

  sync(): void;
  resync(): void;
  aliases(): readonly string[];
  providerIds(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  lookup(alias: string): CatalogModel | undefined;
  onChanged(listener: (event: ProviderCatalogChanged) => void): IDisposable;
}

export const IProviderCatalogRuntime: ServiceIdentifier<IProviderCatalogRuntime> =
  createDecorator<IProviderCatalogRuntime>('providerCatalogRuntime');

export function rawRecordOf(definition: CatalogModelDefinition): ModelRecord {
  return (definition.extras as unknown as CatalogModelExtras).record;
}

export function bucketOfRecord(record: ModelRecord, defaultProvider: string | undefined): string {
  const referenced = record.providerId ?? record.provider ?? defaultProvider;
  if (referenced !== undefined) return referenced;
  return deriveProviderId(nonEmpty(record.baseUrl) ?? '');
}

export function toCatalogProviderInfo(config: ProviderConfig): CatalogProviderInfo {
  return { ...config };
}

export function toCatalogModelDefinition(
  alias: string,
  record: ModelRecord,
  bucket: string,
): CatalogModelDefinition {
  return {
    provider: bucket,
    model: alias,
    capability: capabilityFromDeclared(record.capabilities),
    maxContextSize: record.maxContextSize,
    maxInputSize: record.maxInputSize,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    displayName: record.displayName,
    maxOutputSize: record.maxOutputSize,
    reasoningKey: record.reasoningKey,
    supportEfforts: record.supportEfforts,
    offEffort: record.offEffort,
    alwaysThinking: declaresAlwaysThinking(record.capabilities),
    protocol: record.protocol,
    defaultEffort: record.defaultEffort,
    adaptiveThinking: record.adaptiveThinking,
    betaApi: record.betaApi,
    name: record.name,
    aliases: record.aliases,
    oauth: record.oauth,
    overrides: toCatalogOverrides(record.overrides),
    extras: { record },
  };
}

function toCatalogOverrides(overrides: ModelOverride | undefined): CatalogModelOverrides | undefined {
  if (overrides === undefined) return undefined;
  const out: {
    -readonly [K in keyof CatalogModelOverrides]?: CatalogModelOverrides[K];
  } = {};
  if (overrides.maxContextSize !== undefined) out.maxContextSize = overrides.maxContextSize;
  if (overrides.maxInputSize !== undefined) out.maxInputSize = overrides.maxInputSize;
  if (overrides.maxOutputSize !== undefined) out.maxOutputSize = overrides.maxOutputSize;
  if (overrides.displayName !== undefined) out.displayName = overrides.displayName;
  if (overrides.reasoningKey !== undefined) out.reasoningKey = overrides.reasoningKey;
  if (overrides.adaptiveThinking !== undefined) out.adaptiveThinking = overrides.adaptiveThinking;
  if (overrides.supportEfforts !== undefined) out.supportEfforts = overrides.supportEfforts;
  if (overrides.defaultEffort !== undefined) out.defaultEffort = overrides.defaultEffort;
  if (overrides.offEffort !== undefined) out.offEffort = overrides.offEffort;
  if (overrides.capabilities !== undefined) {
    out.capability = capabilityFromDeclared(overrides.capabilities);
    out.alwaysThinking = declaresAlwaysThinking(overrides.capabilities);
  }
  return out;
}

function declaredSet(capabilities: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((capabilities ?? []).map((capability) => capability.trim().toLowerCase()));
}

function declaresAlwaysThinking(capabilities: readonly string[] | undefined): boolean {
  return declaredSet(capabilities).has('always_thinking');
}

function capabilityFromDeclared(capabilities: readonly string[] | undefined): ModelCapability {
  const declared = declaredSet(capabilities);
  return {
    image_in: declared.has('image_in'),
    video_in: declared.has('video_in'),
    audio_in: declared.has('audio_in'),
    thinking: declared.has('thinking') || declared.has('always_thinking'),
    tool_use: declared.has('tool_use'),
    dynamically_loaded_tools: declared.has('dynamically_loaded_tools'),
  };
}

export class ProviderCatalogRuntimeService extends Disposable implements IProviderCatalogRuntime {
  declare readonly _serviceBrand: undefined;

  private readonly catalog: ProviderCatalog = createProviderCatalogSync();
  private readonly synced = new Map<string, DesiredBucket>();
  private routing = new Map<string, string>();
  private aliasOrder: readonly string[] = [];
  private providerOrder: readonly string[] = [];
  private dirty = true;

  constructor(
    @IModelService private readonly modelService: IModelService,
    @IProviderService private readonly providerService: IProviderService,
  ) {
    super();
    this._register(
      this.modelService.onDidChangeModels(() => {
        this.markDirty();
      }),
    );
    this._register(
      this.providerService.onDidChangeProviders(() => {
        this.markDirty();
      }),
    );
    this._register(
      this.providerService.onDidChangeDefaultProvider(() => {
        this.markDirty();
      }),
    );
    this._register({
      dispose: () => {
        this.catalog.stop();
      },
    });
  }

  sync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.syncAll();
  }

  resync(): void {
    this.dirty = false;
    this.syncAll();
  }

  aliases(): readonly string[] {
    this.sync();
    return this.aliasOrder;
  }

  providerIds(): readonly string[] {
    this.sync();
    return this.providerOrder;
  }

  providerInfo(providerId: string): CatalogProviderInfo | undefined {
    this.sync();
    return this.catalog.providerInfo(providerId);
  }

  lookup(alias: string): CatalogModel | undefined {
    this.sync();
    const bucket = this.routing.get(alias);
    if (bucket === undefined) return undefined;
    return this.catalog.models(bucket).find((model) => model.model === alias);
  }

  onChanged(listener: (event: ProviderCatalogChanged) => void): IDisposable {
    const unsubscribe = this.catalog.onChanged(listener);
    return {
      dispose: () => {
        unsubscribe();
      },
    };
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private syncAll(): void {
    const providers = this.providerService.list();
    const models = this.modelService.list();
    const defaultProvider = this.providerService.getDefaultProvider();
    const desired = new Map<string, { info?: CatalogProviderInfo; models: CatalogModelDefinition[] }>();
    for (const [providerId, config] of Object.entries(providers)) {
      desired.set(providerId, { info: toCatalogProviderInfo(config), models: [] });
    }
    const routing = new Map<string, string>();
    for (const [alias, record] of Object.entries(models)) {
      const bucket = bucketOfRecord(record, defaultProvider);
      routing.set(alias, bucket);
      let entry = desired.get(bucket);
      if (entry === undefined) {
        entry = { models: [] };
        desired.set(bucket, entry);
      }
      entry.models.push(toCatalogModelDefinition(alias, record, bucket));
    }
    this.routing = routing;
    this.aliasOrder = [...routing.keys()];
    this.providerOrder = Object.keys(providers);

    for (const [providerId, bucket] of desired) {
      const next: DesiredBucket = { info: bucket.info, models: bucket.models };
      const previous = this.synced.get(providerId);
      if (previous !== undefined && deepEqual(previous, next)) continue;
      this.synced.set(providerId, next);
      this.catalog.upsertEntry({ providerId, info: bucket.info, models: bucket.models });
    }
    for (const providerId of this.synced.keys()) {
      if (desired.has(providerId)) continue;
      this.synced.delete(providerId);
      this.catalog.remove(providerId);
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IProviderCatalogRuntime,
  ProviderCatalogRuntimeService,
  ScopeActivation.OnScopeCreated,
  'providerCatalogRuntime',
);
