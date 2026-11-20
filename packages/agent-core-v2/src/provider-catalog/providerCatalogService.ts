import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';
import {
  apiKeyEnvMissingMessage,
  declaredProviderCredential,
} from '@moonshot-ai/kimi-code-oauth/provider-credential';

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import {
  createDecorator,
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import type { Event, IWaitUntil } from '#/_base/event';

import {
  createProviderCatalogSync,
  type CatalogModel,
  type CatalogModelDefinition,
  type CatalogProviderInfo,
  type ProviderCatalog,
  type ProviderCatalogChanged,
} from '#human/provider-catalog/catalog';
import {
  createOAuthCredentialProvider,
  createStaticCredentialProvider,
} from '#human/credentials/credentials';
import {
  modelKey,
  type LlmCredentialProvider,
  type LlmEndpoint,
  type ModelCapability,
} from '@moonshot-ai/core/llm/request';
import { createBedrockTokenProvider } from '@moonshot-ai/core/llm/builtin/provider/bedrock/credentials';
import {
  contentsOf,
  createRequester as createCoreRequester,
  type InitializedLlmRequester,
  type InitializedLlmRequestPart,
} from '@moonshot-ai/core/llm/requester';
import { createLlmHeadersTimeoutFetch } from '@moonshot-ai/core/llm/transport/headers-timeout';
import {
  createLlmRequesterExecution,
  type LlmRequesterExecution,
} from '@moonshot-ai/core/llm/policy/policy';
import { CONFIG_INVALID_ERROR_CODE } from '#/provider-catalog/errors';
import type { Protocol, ProtocolProviderOptions } from './protocol/protocol';
import {
  getProtocolBase,
  listProtocolBases,
  type ProtocolBaseId,
  type ResolvedAdapterIdentity,
} from './protocol/protocol-base';
import type {
  DefaultProviderChangedEvent,
  ProviderConfig,
  ProvidersChangedEvent,
  ProvidersSection,
} from './provider/provider';
import {
  coreProviderRequesters,
  getProviderDefinition,
  resolveProviderEndpoint,
} from './provider/provider-definition';

import { ConfigurationRecordStore } from './configuration-store';
import { deepEqual } from './record-diff';
import { routeFor, type ProviderRequesterPresets } from './requester';
import {
  bucketOfRecord,
  rawRecordOf,
  toCatalogModelDefinition,
  toCatalogProviderInfo,
} from './model/catalog-runtime';
import {
  type Model,
  type ModelCatalogItem,
  type ProviderCatalogItem,
  type ProviderCredentialState,
  type SetDefaultModelResponse,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from './model/catalog';
import { ModelCatalogErrors } from './model/errors';
import { IHostRequestHeaders } from './model/host-request-headers';
import type {
  DefaultModelChangedEvent,
  ModelRecord,
  ModelsChangedEvent,
  ModelsSection,
} from './model/model';
import {
  deriveProviderId,
  nonEmpty,
  resolveEndpointBaseUrl,
  resolveModelAuthMaterial,
  resolveModelProtocol,
  withAnthropicProfile,
} from './model/model-auth';
import { IModelOAuthTokens } from './model/model-oauth';
import type { ResolvedModelAuthMaterial } from './model/model.types';

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

interface DesiredBucket {
  readonly info?: CatalogProviderInfo;
  readonly models: readonly CatalogModelDefinition[];
}

export interface IProviderCatalogService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil>;
  readonly onDidChangeProviders: Event<ProvidersChangedEvent & IWaitUntil>;
  readonly onDidChangeDefaultProvider: Event<DefaultProviderChangedEvent & IWaitUntil>;

  getModelRecord(id: string): ModelRecord | undefined;
  listModelRecords(): Readonly<Record<string, ModelRecord>>;
  setModelRecord(id: string, model: ModelRecord): Promise<void>;
  deleteModelRecord(id: string): Promise<void>;
  loadModelRecords(models: ModelsSection, defaultModel: string | undefined): void;
  replaceModelRecords(models: ModelsSection): Promise<void>;
  getDefaultModelId(): string | undefined;
  setDefaultModelId(id: string | undefined): Promise<void>;

  getProviderConfig(name: string): ProviderConfig | undefined;
  listProviderConfigs(): Readonly<Record<string, ProviderConfig>>;
  setProviderConfig(name: string, config: ProviderConfig): Promise<void>;
  deleteProviderConfig(name: string): Promise<void>;
  loadProviderConfigs(providers: ProvidersSection, defaultProvider: string | undefined): void;
  replaceProviderConfigs(providers: ProvidersSection): Promise<void>;
  getDefaultProviderId(): string | undefined;
  setDefaultProviderId(id: string | undefined): Promise<void>;

  get(id: string): Model;
  findByName(name: string): readonly string[];
  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
  notifyConfigChanged(): void;

  sync(): void;
  resync(): void;
  aliases(): readonly string[];
  providerIds(): readonly string[];
  providerInfo(providerId: string): CatalogProviderInfo | undefined;
  lookup(alias: string): CatalogModel | undefined;
  onChanged(listener: (event: ProviderCatalogChanged) => void): IDisposable;

  supportedProtocols(): readonly Protocol[];
  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity;
  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId;
  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability | undefined;

  createRequester(
    model: Model,
    part?: InitializedLlmRequestPart,
    execution?: LlmRequesterExecution,
  ): InitializedLlmRequester;
}

export const IProviderCatalogService: ServiceIdentifier<IProviderCatalogService> =
  createDecorator<IProviderCatalogService>('providerCatalogService');

const defaultOAuthTokens: IModelOAuthTokens = {
  _serviceBrand: undefined,
  hasCachedAccessToken: () => Promise.resolve(false),
  getAccessToken: () => Promise.reject(new Error('auth.login_required')),
};

const defaultHostRequestHeaders: IHostRequestHeaders = {
  headers: {},
  thirdPartyHeaders: {},
};

export class ProviderCatalogService extends Disposable implements IProviderCatalogService {
  declare readonly _serviceBrand: undefined;

  private readonly modelStore = this._register(
    new ConfigurationRecordStore<ModelRecord>(false, () => this.markDirty()),
  );
  private readonly providerStore = this._register(
    new ConfigurationRecordStore<ProviderConfig>(
      true,
      () => this.markDirty(),
      () => this.markDirty(),
    ),
  );

  readonly ready = Promise.all([this.modelStore.ready, this.providerStore.ready]).then(
    () => undefined,
  );
  readonly onDidChangeModels: Event<ModelsChangedEvent & IWaitUntil> =
    this.modelStore.onDidChangeRecords;
  readonly onDidChangeDefaultModel: Event<DefaultModelChangedEvent & IWaitUntil> =
    this.modelStore.onDidChangeDefaultId;
  readonly onDidChangeProviders: Event<ProvidersChangedEvent & IWaitUntil> =
    this.providerStore.onDidChangeRecords;
  readonly onDidChangeDefaultProvider: Event<DefaultProviderChangedEvent & IWaitUntil> =
    this.providerStore.onDidChangeDefaultId;

  private readonly catalog: ProviderCatalog = createProviderCatalogSync();
  private readonly synced = new Map<string, DesiredBucket>();
  private routing = new Map<string, string>();
  private aliasOrder: readonly string[] = [];
  private providerOrder: readonly string[] = [];
  private dirty = true;
  private readonly cache = new Map<string, Model>();
  private readonly detectedReasoningKeys = new Map<string, string>();
  private readonly presets: ProviderRequesterPresets = coreProviderRequesters;

  constructor(
    @IInstantiationService private readonly instantiation?: IInstantiationService,
  ) {
    super();
    this._register(
      this.onChanged((event) => {
        this.invalidate(event.providers);
      }),
    );
    this._register({
      dispose: () => {
        this.catalog.stop();
      },
    });
  }

  protected get oauth(): IModelOAuthTokens {
    return this.instantiation?.invokeFunction((accessor) => accessor.get(IModelOAuthTokens)) ??
      defaultOAuthTokens;
  }

  protected get hostRequestHeaders(): IHostRequestHeaders {
    return this.instantiation?.invokeFunction((accessor) => accessor.get(IHostRequestHeaders)) ??
      defaultHostRequestHeaders;
  }

  getModelRecord(id: string): ModelRecord | undefined {
    return this.modelStore.get(id);
  }

  listModelRecords(): Readonly<Record<string, ModelRecord>> {
    return this.modelStore.list();
  }

  setModelRecord(id: string, model: ModelRecord): Promise<void> {
    return this.modelStore.set(id, model);
  }

  deleteModelRecord(id: string): Promise<void> {
    return this.modelStore.delete(id);
  }

  loadModelRecords(models: ModelsSection, defaultModel: string | undefined): void {
    this.modelStore.load(models, defaultModel);
  }

  replaceModelRecords(models: ModelsSection): Promise<void> {
    return this.modelStore.replace(models);
  }

  getDefaultModelId(): string | undefined {
    return this.modelStore.getDefaultId();
  }

  setDefaultModelId(id: string | undefined): Promise<void> {
    return this.modelStore.setDefaultId(id);
  }

  getProviderConfig(name: string): ProviderConfig | undefined {
    return this.providerStore.get(name);
  }

  listProviderConfigs(): Readonly<Record<string, ProviderConfig>> {
    return this.providerStore.list();
  }

  setProviderConfig(name: string, config: ProviderConfig): Promise<void> {
    return this.providerStore.set(name, config);
  }

  deleteProviderConfig(name: string): Promise<void> {
    return this.providerStore.delete(name);
  }

  loadProviderConfigs(providers: ProvidersSection, defaultProvider: string | undefined): void {
    this.providerStore.load(providers, defaultProvider);
  }

  replaceProviderConfigs(providers: ProvidersSection): Promise<void> {
    return this.providerStore.replace(providers);
  }

  getDefaultProviderId(): string | undefined {
    return this.providerStore.getDefaultId();
  }

  setDefaultProviderId(id: string | undefined): Promise<void> {
    return this.providerStore.setDefaultId(id);
  }

  notifyConfigChanged(): void {
    this.resync();
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
    return this.catalog.models(bucket).find((model) => model.id === alias);
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
    const providers = this.listProviderConfigs();
    const models = this.listModelRecords();
    const defaultProvider = this.getDefaultProviderId();
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

  private invalidate(providerIds: readonly string[]): void {
    if (providerIds.length === 0) return;
    const changed = new Set(providerIds);
    for (const [alias, model] of this.cache) {
      if (changed.has(model.providerName)) {
        this.cache.delete(alias);
      }
    }
  }

  get(id: string): Model {
    return this.entry(id);
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const alias of this.aliases()) {
      const definition = this.lookup(alias);
      if (definition === undefined) continue;
      const record = rawRecordOf(definition);
      if (record.name === name || record.model === name || (record.aliases ?? []).includes(name)) {
        out.push(alias);
      }
    }
    return out;
  }

  private entry(id: string): Model {
    this.sync();
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const model = this.buildModel(id);
    this.cache.set(id, model);
    return model;
  }

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const out: ModelCatalogItem[] = [];
    for (const modelId of this.aliases()) {
      const definition = this.lookup(modelId);
      if (definition === undefined) continue;
      const record = rawRecordOf(definition);
      const providerType = this.providerTypeOf(record);
      try {
        out.push(toProtocolModel(this.get(modelId), record, providerType));
      } catch {
        out.push(toProtocolModelFallback(modelId, record, providerType));
      }
    }
    return out;
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const records = this.allRecords();
    const globalDefaultModel = this.getDefaultModelId();
    const out: ProviderCatalogItem[] = [];
    for (const providerId of this.providerIds()) {
      const provider = this.providerInfo(providerId);
      if (provider === undefined) continue;
      out.push(await this.toCatalogProvider(providerId, provider, records, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.providerInfo(providerId);
    if (provider === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
        `provider ${providerId} does not exist`,
      );
    }
    return this.toCatalogProvider(
      providerId,
      provider,
      this.allRecords(),
      this.getDefaultModelId(),
    );
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const definition = this.lookup(modelId);
    if (definition === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.MODEL_NOT_FOUND,
        `model ${modelId} does not exist`,
      );
    }
    const record = rawRecordOf(definition);
    const model = this.get(modelId);
    await this.setDefaultModelId(modelId);
    return {
      default_model: modelId,
      model: toProtocolModel(model, record, this.providerTypeOf(record)),
    };
  }

  private allRecords(): Readonly<Record<string, ModelRecord>> {
    const out: Record<string, ModelRecord> = {};
    for (const alias of this.aliases()) {
      const definition = this.lookup(alias);
      if (definition !== undefined) out[alias] = rawRecordOf(definition);
    }
    return out;
  }

  private async toCatalogProvider(
    providerId: string,
    provider: CatalogProviderInfo,
    models: Readonly<Record<string, ModelRecord>>,
    globalDefaultModel: string | undefined,
  ): Promise<ProviderCatalogItem> {
    const credential = await this.resolveCredential(providerId, provider);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential);
  }

  private async resolveCredential(
    providerId: string,
    provider: CatalogProviderInfo,
  ): Promise<ProviderCredentialState> {
    const declared = declaredProviderCredential(provider, providerId);
    const hasApiKey = hasConfiguredApiKey(provider);
    const hasOAuthToken = await this.hasCachedToken(providerId, provider);
    return {
      hasApiKey,
      hasOAuthToken,
      supportsAmbientCredential: provider.type === 'bedrock' && !hasApiKey && !hasOAuthToken,
      hasCredentialConflict: declared.kind === 'conflict',
    };
  }

  private async hasCachedToken(providerId: string, provider: CatalogProviderInfo): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    return this.oauth.hasCachedAccessToken(providerId, provider.oauth);
  }

  private providerTypeOf(record: ModelRecord): string | undefined {
    const providerId =
      record.providerId ?? record.provider ?? this.getDefaultProviderId();
    return this.providerInfo(providerId ?? '')?.type ?? record.protocol;
  }

  private buildModel(id: string): Model {
    const definition = this.lookup(id);
    if (definition === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" is not configured in config.toml.`,
        { details: { model: id } },
      );
    }
    const configuredModel = rawRecordOf(definition);

    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } =
      this.resolveProviderContext(id, configuredModel);

    const protocol = this.resolveProtocol(id, configuredModel, providerConfig);
    const model = withAnthropicProfile(
      effectiveRecordOf(definition),
      providerConfig?.type ?? configuredModel.protocol,
    );
    const wireName = model.name ?? model.model;

    const auth = resolveModelAuthMaterial({
      modelId: id,
      model,
      provider: providerConfig,
      providerName,
    });
    const credentialProvider = this.buildCredentialProvider(providerName, auth);

    const providerType = providerConfig?.type ?? protocol;
    const resolvedBaseUrl =
      protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    if (wireName === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const detectedCapability = this.resolveCapability(
      protocol,
      wireName,
      providerType,
    );
    const capabilities = resolveModelCapabilities(model.capabilities, detectedCapability);
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
    );
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));

    return {
      id,
      aliases: model.aliases ?? [],
      protocol,
      spec: {
        provider: providerType ?? protocol,
        name: wireName,
        capability: capabilities,
        thinking: {
          supportEfforts: model.supportEfforts,
          defaultEffort: model.defaultEffort,
          offEffort: providerOptions?.offEffort,
          alwaysThinking: declared.has('always_thinking'),
          adaptiveThinking: providerOptions?.adaptiveThinking,
        },
        maxContextSize: model.maxContextSize,
        maxInputSize: model.maxInputSize,
      },
      endpoint: {
        baseUrl: resolvedBaseUrl,
        headers: resolveOutboundHeaders(
          providerConfig?.type,
          providerConfig?.customHeaders,
          this.hostRequestHeaders,
        ),
        credentials: credentialProvider,
      },
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      providerType,
      providerName,
      providerOptions,
    };
  }

  private resolveProviderContext(
    id: string,
    model: ModelRecord,
  ): {
    readonly providerConfig: CatalogProviderInfo | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string | undefined;
  } {
    const providerId =
      model.providerId ?? model.provider ?? this.getDefaultProviderId();
    if (providerId !== undefined) {
      const providerConfig = this.providerInfo(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      return {
        providerConfig,
        providerName: providerId,
        resolvedBaseUrl: resolveEndpointBaseUrl(model, providerConfig, providerId),
      };
    }

    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
    return {
      providerConfig: undefined,
      providerName: deriveProviderId(modelBaseUrl),
      resolvedBaseUrl: modelBaseUrl,
    };
  }

  private resolveProtocol(
    id: string,
    model: ModelRecord,
    provider: CatalogProviderInfo | undefined,
  ): Protocol {
    const protocol = resolveModelProtocol(model, provider);
    if (protocol === undefined) {
      throw new Error2(
        CONFIG_INVALID_ERROR_CODE,
        `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
      );
    }
    return protocol;
  }

  private buildCredentialProvider(
    providerName: string,
    auth: ResolvedModelAuthMaterial,
  ): LlmCredentialProvider {
    if (auth.apiKey !== undefined) {
      return createStaticCredentialProvider(auth.apiKey);
    }
    if (auth.apiKeyEnv !== undefined) {
      const envName = auth.apiKeyEnv;
      return {
        resolve: () => {
          const apiKey = nonEmpty(process.env[envName]);
          if (apiKey === undefined) {
            throw new Error2(
              CONFIG_INVALID_ERROR_CODE,
              apiKeyEnvMissingMessage(providerName, envName),
            );
          }
          return { apiKey };
        },
      };
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const tokens = this.oauth;
      return createOAuthCredentialProvider((options) =>
        tokens.getAccessToken(providerKey, oauthRef, { force: options?.force === true }),
      );
    }
    if (auth.aws !== undefined) {
      return createBedrockTokenProvider({
        region: auth.aws.region,
        profile: auth.aws.profile,
      });
    }
    return createStaticCredentialProvider(undefined);
  }

  supportedProtocols(): readonly Protocol[] {
    return listProtocolBases().map((base) => base.id);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    const baseId: ProtocolBaseId = definition?.baseProtocol ?? protocol;
    return {
      baseId,
      thinkingDriven: definition?.thinkingDriven,
      strictThinkingValidation: definition?.strictThinkingValidation,
    };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    return definition?.baseProtocol ?? protocol;
  }

  resolveCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ModelCapability | undefined {
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    return (
      definition?.capability?.(modelName) ??
      getProtocolBase(identity.baseId)?.capability?.(modelName)
    );
  }

  createRequester(
    model: Model,
    part?: InitializedLlmRequestPart,
    execution: LlmRequesterExecution = createLlmRequesterExecution(),
  ): InitializedLlmRequester {
    const route = routeFor(model, this.presets);
    const base = contentsOf(route.requester);
    const protocol = base.protocol;
    if (protocol?.base === undefined) throw new TypeError('requester protocol is not initialized');
    const protocolBase = protocol.base;
    let options = route.options;
    if (model.protocol === 'openai') {
      const resolved = options as { readonly reasoningKey?: string } | undefined;
      if (resolved?.reasoningKey === undefined) {
        const key = modelKey(model.spec, model.endpoint);
        options = {
          ...resolved,
          detectedReasoningKey: () => this.detectedReasoningKeys.get(key),
          onReasoningKey: (reasoningKey: string) => {
            if (!this.detectedReasoningKeys.has(key)) {
              this.detectedReasoningKeys.set(key, reasoningKey);
            }
          },
        };
      }
    }
    const endpoint: LlmEndpoint = {
      ...base.endpoint,
      ...model.endpoint,
      fetch:
        protocolBase.usesEndpointFetch === false
          ? undefined
          : (input, init) => createLlmHeadersTimeoutFetch()(input, init),
    };
    const initialized = createCoreRequester(execution).with(route.requester).with({
      protocol: {
        options,
        stream: true,
        recoveryKey: JSON.stringify([
          model.protocol,
          model.providerType,
          route.providerId,
          model.providerOptions?.betaApi === true,
          model.providerOptions?.vertexai === true,
        ]),
      },
      endpoint,
      model: {
        spec: { ...model.spec, provider: route.providerId },
      },
    });
    const resolved = initialized.with(part ?? {});
    const spec = contentsOf(resolved).model?.spec;
    if (spec === undefined) throw new TypeError('requester model is not initialized');
    return resolved.with({ model: { spec: { ...spec, provider: route.providerId } } });
  }
}

export function resolveOutboundHeaders(
  providerType: string | undefined,
  customHeaders: Readonly<Record<string, string>> | undefined,
  host: Pick<IHostRequestHeaders, 'headers' | 'thirdPartyHeaders'>,
): Readonly<Record<string, string>> {
  const forwardsAll =
    providerType !== undefined &&
    getProviderDefinition(providerType)?.hostHeaders === 'full';
  const hostLayer = forwardsAll ? host.headers : host.thirdPartyHeaders;
  return { ...parseKimiCodeCustomHeaders(), ...hostLayer, ...customHeaders };
}

function resolveModelCapabilities(
  declaredCapabilities: readonly string[] | undefined,
  detected: ModelCapability | undefined,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  return {
    image_in: declared.has('image_in') || detected?.image_in === true,
    video_in: declared.has('video_in') || detected?.video_in === true,
    audio_in: declared.has('audio_in') || detected?.audio_in === true,
    thinking:
      declared.has('thinking') || declared.has('always_thinking') || detected?.thinking === true,
    tool_use: declared.has('tool_use') || (detected !== undefined && detected.tool_use !== false),
    dynamically_loaded_tools:
      declared.has('dynamically_loaded_tools') || detected?.dynamically_loaded_tools === true,
  };
}

function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function effectiveRecordOf(definition: CatalogModel): ModelRecord {
  const raw = rawRecordOf(definition);
  const { overrides, ...base } = raw;
  return {
    ...base,
    capabilities: overrides?.capabilities ?? raw.capabilities,
    maxContextSize: definition.spec.maxContextSize,
    maxInputSize: definition.spec.maxInputSize,
    maxOutputSize: definition.maxOutputSize,
    displayName: definition.displayName,
    reasoningKey: definition.reasoningKey,
    adaptiveThinking: definition.spec.thinking?.adaptiveThinking,
    supportEfforts:
      definition.spec.thinking?.supportEfforts === undefined
        ? undefined
        : [...definition.spec.thinking.supportEfforts],
    defaultEffort: definition.spec.thinking?.defaultEffort,
    offEffort: definition.spec.thinking?.offEffort,
  };
}

function buildProtocolProviderOptions(
  model: ModelRecord,
  protocol: Protocol,
  provider: CatalogProviderInfo | undefined,
  baseUrl: string | undefined,
): ProtocolProviderOptions | undefined {
  const options: MutableProtocolProviderOptions = {};

  switch (protocol) {
    case 'anthropic':
      if (model.maxOutputSize !== undefined) options.defaultMaxTokens = model.maxOutputSize;
      if (model.supportEfforts !== undefined) options.supportEfforts = model.supportEfforts;
      if (model.adaptiveThinking !== undefined) options.adaptiveThinking = model.adaptiveThinking;
      if (model.betaApi !== undefined) options.betaApi = model.betaApi;
      break;
    case 'openai': {
      const reasoningKey = nonEmpty(model.reasoningKey);
      if (reasoningKey !== undefined) options.reasoningKey = reasoningKey;
      if (model.offEffort !== undefined) options.offEffort = model.offEffort;
      break;
    }
    case 'google-genai': {
      const project = vertexAIProject(provider);
      const location = vertexAILocation(provider, baseUrl);
      if (project !== undefined && location !== undefined) {
        options.vertexai = true;
        options.project = project;
        options.location = location;
      }
      break;
    }
    case 'openai_responses':
      if (model.offEffort !== undefined) options.offEffort = model.offEffort;
      break;
    default: {
      const exhaustive: never = protocol;
      void exhaustive;
    }
  }

  return Object.values(options).some((value) => value !== undefined)
    ? options
    : undefined;
}

function vertexAIProject(provider: CatalogProviderInfo | undefined): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(
  provider: CatalogProviderInfo | undefined,
  baseUrl: string | undefined,
): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_LOCATION') ?? locationFromVertexAIBaseUrl(baseUrl);
}

function envValue(env: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  return nonEmpty(env?.[key]);
}

function locationFromVertexAIBaseUrl(baseUrl: string | undefined): string | undefined {
  const url = nonEmpty(baseUrl);
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname;
    const suffix = '-aiplatform.googleapis.com';
    return host.endsWith(suffix) ? nonEmpty(host.slice(0, -suffix.length)) : undefined;
  } catch {
    return undefined;
  }
}

function hasConfiguredApiKey(provider: CatalogProviderInfo): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  const apiKeyEnv = nonEmpty(provider.apiKeyEnv);
  if (apiKeyEnv !== undefined) return nonEmpty(process.env[apiKeyEnv]) !== undefined;
  if (provider.type === undefined) return false;
  return resolveProviderEndpoint(provider.type, provider.env ?? {}).apiKey !== undefined;
}

registerScopedService(
  LifecycleScope.App,
  IProviderCatalogService,
  ProviderCatalogService,
  ScopeActivation.OnScopeCreated,
  'provider',
);
