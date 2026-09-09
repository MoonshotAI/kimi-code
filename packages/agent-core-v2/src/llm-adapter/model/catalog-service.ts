import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';

import type { CatalogModel, CatalogProviderInfo } from '#human/llm/provider-catalog';
import type { ModelCapability } from '../contract/capability';
import { CONFIG_INVALID_ERROR_CODE } from '../contract/errors';
import type { TokenUsage } from '#human/llm/usage';
import {
  IProtocolAdapterRegistry,
  type Protocol,
  type ProtocolProviderOptions,
} from '../protocol/protocol';
import { IProviderService } from '../provider/provider';
import {
  getProviderDefinition,
  resolveProviderEndpoint,
} from '../provider/provider-definition';

import {
  type AuthProvider,
  IModelCatalog,
  type Model,
  type ModelCatalogItem,
  type ModelPingResult,
  type ProviderCatalogItem,
  type ProviderCredentialState,
  type ProviderRequestAuth,
  type SetDefaultModelResponse,
  StaticAuthProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from './catalog';
import { IProviderCatalogRuntime, rawRecordOf } from './catalog-runtime';
import { ModelCatalogErrors } from './errors';
import { IHostRequestHeaders } from './host-request-headers';
import { IModelService, type ModelRecord } from './model';
import {
  deriveProviderId,
  nonEmpty,
  resolveEndpointBaseUrl,
  resolveModelAuthMaterial,
  resolveModelProtocol,
  withAnthropicProfile,
} from './model-auth';
import { IModelOAuthTokens } from './model-oauth';
import type { ResolvedModelAuthMaterial } from './model.types';
import type { ModelRequester } from './model-requester';
import { ModelRequesterImpl } from './model-requester-impl';

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

interface CatalogEntry {
  readonly model: Model;
  readonly requester: ModelRequester;
}

export class ModelCatalog extends Disposable implements IModelCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly cache = new Map<string, CatalogEntry>();

  constructor(
    @IProviderCatalogRuntime private readonly runtime: IProviderCatalogRuntime,
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IModelOAuthTokens private readonly oauth: IModelOAuthTokens,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
  ) {
    super();
    this._register(
      this.runtime.onChanged((event) => {
        this.invalidate(event.providers);
      }),
    );
  }

  notifyConfigChanged(): void {
    this.runtime.resync();
  }

  private invalidate(providerIds: readonly string[]): void {
    if (providerIds.length === 0) return;
    const changed = new Set(providerIds);
    for (const [alias, entry] of this.cache) {
      if (changed.has(entry.model.providerName)) {
        this.cache.delete(alias);
      }
    }
  }

  get(id: string): Model {
    return this.entry(id).model;
  }

  getRequester(id: string): ModelRequester {
    return this.entry(id).requester;
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const alias of this.runtime.aliases()) {
      const definition = this.runtime.lookup(alias);
      if (definition === undefined) continue;
      const record = rawRecordOf(definition);
      if (record.name === name || record.model === name || (record.aliases ?? []).includes(name)) {
        out.push(alias);
      }
    }
    return out;
  }

  private entry(id: string): CatalogEntry {
    this.runtime.sync();
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const model = this.buildModel(id);
    const entry: CatalogEntry = {
      model,
      requester: new ModelRequesterImpl(model, this.protocolRegistry),
    };
    this.cache.set(id, entry);
    return entry;
  }

  async ping(id: string): Promise<ModelPingResult> {
    const { requester } = this.entry(id);
    const startedAt = Date.now();
    try {
      let text = '';
      let usage: TokenUsage | undefined;
      let finishReason: string | undefined;
      for await (const event of requester.request(
        {
          systemPrompt: 'You are a connectivity probe. Answer with the single word "pong".',
          tools: [],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }],
        },
        undefined,
        { maxCompletionTokens: 512 },
      )) {
        if (event.type === 'part' && event.part.type === 'text') {
          text += event.part.text;
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'finish') {
          finishReason = event.providerFinishReason ?? event.rawFinishReason;
        }
      }
      return { ok: true, durationMs: Date.now() - startedAt, text: text.trim(), finishReason, usage };
    } catch (error) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const out: ModelCatalogItem[] = [];
    for (const modelId of this.runtime.aliases()) {
      const definition = this.runtime.lookup(modelId);
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
    const globalDefaultModel = this.models.getDefaultModel();
    const out: ProviderCatalogItem[] = [];
    for (const providerId of this.runtime.providerIds()) {
      const provider = this.runtime.providerInfo(providerId);
      if (provider === undefined) continue;
      out.push(await this.toCatalogProvider(providerId, provider, records, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.runtime.providerInfo(providerId);
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
      this.models.getDefaultModel(),
    );
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const definition = this.runtime.lookup(modelId);
    if (definition === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.MODEL_NOT_FOUND,
        `model ${modelId} does not exist`,
      );
    }
    const record = rawRecordOf(definition);
    const model = this.get(modelId);
    await this.models.setDefaultModel(modelId);
    return {
      default_model: modelId,
      model: toProtocolModel(model, record, this.providerTypeOf(record)),
    };
  }

  private allRecords(): Readonly<Record<string, ModelRecord>> {
    const out: Record<string, ModelRecord> = {};
    for (const alias of this.runtime.aliases()) {
      const definition = this.runtime.lookup(alias);
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
    return {
      hasApiKey: hasConfiguredApiKey(provider),
      hasOAuthToken: await this.hasCachedToken(providerId, provider),
    };
  }

  private async hasCachedToken(providerId: string, provider: CatalogProviderInfo): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    return this.oauth.hasCachedAccessToken(providerId, provider.oauth);
  }

  private providerTypeOf(record: ModelRecord): string | undefined {
    const providerId =
      record.providerId ?? record.provider ?? this.providers.getDefaultProvider();
    return this.runtime.providerInfo(providerId ?? '')?.type ?? record.protocol;
  }

  private buildModel(id: string): Model {
    const definition = this.runtime.lookup(id);
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
    const authProvider = this.buildAuthProvider(providerName, auth);

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

    const detectedCapability = this.protocolRegistry.resolveCapability(
      protocol,
      wireName,
      providerType,
    );
    const capabilities = resolveModelCapabilities(
      model.capabilities,
      detectedCapability,
      model.maxContextSize,
      model.maxInputSize,
    );
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
    );
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));

    return {
      id,
      name: wireName,
      aliases: model.aliases ?? [],
      protocol,
      baseUrl: resolvedBaseUrl,
      headers: resolveOutboundHeaders(
        providerConfig?.type,
        providerConfig?.customHeaders,
        this.hostRequestHeaders,
      ),
      capabilities,
      maxContextSize: model.maxContextSize,
      maxInputSize: model.maxInputSize,
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
      alwaysThinking: declared.has('always_thinking'),
      providerType,
      providerName,
      authProvider,
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
      model.providerId ?? model.provider ?? this.providers.getDefaultProvider();
    if (providerId !== undefined) {
      const providerConfig = this.runtime.providerInfo(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          CONFIG_INVALID_ERROR_CODE,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      return {
        providerConfig,
        providerName: providerId,
        resolvedBaseUrl: resolveEndpointBaseUrl(model, providerConfig),
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

  private buildAuthProvider(providerName: string, auth: ResolvedModelAuthMaterial): AuthProvider {
    if (auth.apiKey !== undefined) {
      return new StaticAuthProvider(auth.apiKey);
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const tokens = this.oauth;
      return {
        canRefresh: true,
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const apiKey = await tokens.getAccessToken(providerKey, oauthRef, {
            force: options?.force === true,
          });
          return { apiKey };
        },
      };
    }
    return new StaticAuthProvider(undefined);
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
  detected: ModelCapability,
  maxContextSize: number,
  maxInputSize: number | undefined,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: maxContextSize,
    max_input_tokens: maxInputSize,
    dynamically_loaded_tools:
      declared.has('dynamically_loaded_tools') ||
      detected.dynamically_loaded_tools === true,
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
    maxContextSize: definition.maxContextSize,
    maxInputSize: definition.maxInputSize,
    maxOutputSize: definition.maxOutputSize,
    displayName: definition.displayName,
    reasoningKey: definition.reasoningKey,
    adaptiveThinking: definition.adaptiveThinking,
    supportEfforts:
      definition.supportEfforts === undefined ? undefined : [...definition.supportEfforts],
    defaultEffort: definition.defaultEffort,
    offEffort: definition.offEffort,
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
  if (provider.type === undefined) return false;
  return resolveProviderEndpoint(provider.type, provider.env ?? {}).apiKey !== undefined;
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalog,
  ModelCatalog,
  ScopeActivation.OnScopeCreated,
  'modelCatalog',
);
