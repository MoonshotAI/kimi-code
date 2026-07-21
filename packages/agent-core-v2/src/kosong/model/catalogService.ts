/**
 * `kosong/model` domain (L2) — `ModelCatalog`, the single place that builds
 * Models.
 *
 * Reads Model / Provider config, resolves the auth closure (provider-level
 * credential or Model-inline override), and assembles the pure-data
 * `Model` plus its `ModelRequester` — cached together by model id. Bound at
 * App scope; resolution is shared across sessions.
 *
 * Two config-driven paths (unchanged from the legacy resolver):
 *   - **Structured** — `Model.providerId` points at a `[providers.*]` entry.
 *     Auth comes from the Provider unless the Model carries an override
 *     (`apiKey` / `oauth`).
 *   - **Flat** — `Model.baseUrl` is inline; the catalog synthesizes a
 *     Provider record keyed by the URL's origin so multiple Models on the
 *     same host converge on the same Provider metadata. Auth comes from the
 *     Model itself.
 *
 * Everything vendor-shaped goes through the registries, never a hardcoded
 * switch: the wire protocol falls back from an explicit `protocol` to the
 * referenced provider vendor's declared `baseProtocol`; endpoint and
 * credential env fallbacks resolve through `resolveProviderEndpoint` against
 * the config env bag; host-header forwarding follows the vendor definition's
 * `hostHeaders`; capability detection is `resolveCapability(protocol, name,
 * providerType)`.
 *
 * Caching (load-bearing): assembled entries are invalidated ONLY by the
 * model/provider config-change events. Tests that mutate config
 * behind the services' backs (bypassing those events) must call
 * `notifyConfigChanged()` to drop the cache — otherwise `get` keeps serving
 * the previous generation's Model.
 *
 * Inspection: every assembly also captures a `ResolutionTraceCollector`
 * (provenance records + intermediate artifacts, reference-only) alongside the
 * Model in the same cache entry. `inspect(id)` assembles the god object from
 * that trace on demand — same pass, same generation, never a re-resolution.
 *
 * Enumeration & default pointer: `listModels` projects every configured
 * model from the SAME materialization `get` serves (falling back to the
 * config-only projection for models that fail to materialize, so broken
 * config stays visible); `listProviders` / `getProvider` project the
 * provider registry plus credential state. `setDefaultModel` writes the
 * global default-model pointer (`DEFAULT_MODEL_SECTION`) after a
 * materialization gate — the catalog's only write. The remote-discovery
 * refresh lives in `kosong/provider/discovery`, not here.
 */

import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import {
  IProtocolAdapterRegistry,
  ProtocolSchema,
  type Protocol,
  type ProtocolProviderOptions,
} from '#/kosong/protocol/protocol';

import { IConfigService } from '../../app/config/config';
import { ConfigErrors } from '../../app/config/errors';
import {
  LATEST_OPUS_PROFILE,
  matchKnownAnthropicModelProfile,
} from '../provider/bases/anthropic/anthropic-profile';
import {
  DEFAULT_PROVIDER_SECTION,
  IProviderService,
  type ProviderConfig,
} from '../provider/provider';
import {
  explainProviderEndpoint,
  getProviderDefinition,
  resolveProviderEndpoint,
} from '../provider/providerDefinition';

import {
  type AuthProvider,
  IModelCatalog,
  type Model,
  type ModelCatalogItem,
  type ModelPingResult,
  type ProviderCatalogItem,
  type ProviderCredentialState,
  type SetDefaultModelResponse,
  StaticAuthProvider,
  toProtocolModel,
  toProtocolModelFallback,
  toProtocolProvider,
} from './catalog';
import { ModelCatalogErrors } from './errors';
import { IHostRequestHeaders } from './hostRequestHeaders';
import {
  assembleModelInspection,
  attributeEffectiveFields,
  attributeProviderOptions,
  type ModelInspection,
  ResolutionTraceCollector,
  TRACE,
} from './inspection';
import { DEFAULT_MODEL_SECTION, IModelService, type ModelRecord } from './model';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
} from './modelAuth';
import type { ResolvedModelAuthMaterial } from './model.types';
import type { ModelRequester } from './modelRequester';
import { ModelRequesterImpl } from './modelRequesterImpl';
import { drivesThinkingThroughTraits } from './thinking';

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

interface CatalogEntry {
  readonly model: Model;
  readonly requester: ModelRequester;
  /** The provenance trace of the resolution that produced `model` (same pass). */
  readonly trace: ResolutionTraceCollector;
}

export class ModelCatalog extends Disposable implements IModelCatalog {
  declare readonly _serviceBrand: undefined;

  private readonly cache = new Map<string, CatalogEntry>();

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IProviderService private readonly providers: IProviderService,
    @IModelService private readonly models: IModelService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
  ) {
    super();
    // Cache invalidation rides the two config-change events; any change in
    // either of them can alter an assembled Model, so the whole cache drops.
    this._register(this.models.onDidChangeModels(() => this.notifyConfigChanged()));
    this._register(this.providers.onDidChangeProviders(() => this.notifyConfigChanged()));
  }

  /**
   * Drop every assembled entry. Called by the config-change handlers; exposed
   * so tests and harnesses that mutate config WITHOUT going through the
   * change events can force re-assembly on the next `get`/`getRequester`.
   */
  notifyConfigChanged(): void {
    this.cache.clear();
  }

  get(id: string): Model {
    return this.entry(id).model;
  }

  getRequester(id: string): ModelRequester {
    return this.entry(id).requester;
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const [id, m] of Object.entries(this.models.list())) {
      const alias = m.name === name || m.model === name || (m.aliases ?? []).includes(name);
      if (alias) out.push(id);
    }
    return out;
  }

  private entry(id: string): CatalogEntry {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const trace = new ResolutionTraceCollector();
    const model = this.buildModel(id, trace);
    const entry: CatalogEntry = {
      model,
      requester: new ModelRequesterImpl(model, this.protocolRegistry),
      trace,
    };
    this.cache.set(id, entry);
    return entry;
  }

  inspect(id: string): ModelInspection {
    // The god object of the SAME resolution `get`/`getRequester` serve: the
    // entry's trace was captured by that very pass, and the assembly (incl.
    // secret redaction) re-runs on every call — inspect is never cached.
    const { model, trace } = this.entry(id);
    return assembleModelInspection({ id, model, trace });
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
    const models = this.models.list();
    return Object.entries(models).map(([modelId, record]) => {
      const providerType = this.providerTypeOf(record);
      try {
        return toProtocolModel(this.get(modelId), record, providerType);
      } catch {
        // Broken config must stay visible (and fixable) in listings: fall
        // back to the config-only projection when materialization fails.
        return toProtocolModelFallback(modelId, record, providerType);
      }
    });
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const providers = this.providers.list();
    const models = this.models.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      out.push(await this.toCatalogProvider(providerId, provider, models, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
        `provider ${providerId} does not exist`,
      );
    }
    const models = this.models.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    return this.toCatalogProvider(providerId, provider, models, globalDefaultModel);
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const record = this.models.get(modelId);
    if (record === undefined) {
      throw new Error2(
        ModelCatalogErrors.codes.MODEL_NOT_FOUND,
        `model ${modelId} does not exist`,
      );
    }
    // Materialization gate: a model that cannot resolve (dangling provider
    // reference, conflicting credentials, ...) must not become the default.
    const model = this.get(modelId);
    await this.config.set(DEFAULT_MODEL_SECTION, modelId);
    return {
      default_model: modelId,
      model: toProtocolModel(model, record, this.providerTypeOf(record)),
    };
  }

  private async toCatalogProvider(
    providerId: string,
    provider: ProviderConfig,
    models: Readonly<Record<string, ModelRecord>>,
    globalDefaultModel: string | undefined,
  ): Promise<ProviderCatalogItem> {
    const credential = await this.resolveCredential(providerId, provider);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential);
  }

  private async resolveCredential(
    providerId: string,
    provider: ProviderConfig,
  ): Promise<ProviderCredentialState> {
    return {
      hasApiKey: hasConfiguredApiKey(provider),
      hasOAuthToken: await this.hasCachedToken(providerId, provider),
    };
  }

  private async hasCachedToken(providerId: string, provider: ProviderConfig): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    try {
      const token = await this.oauth.getCachedAccessToken(providerId, provider.oauth);
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }

  private providerTypeOf(record: ModelRecord): string | undefined {
    const providerId =
      record.providerId ?? record.provider ?? this.config.get<string>(DEFAULT_PROVIDER_SECTION);
    return this.providers.get(providerId ?? '')?.type ?? record.protocol;
  }

  private buildModel(id: string, trace: ResolutionTraceCollector): Model {
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }
    trace.capture(TRACE.configuredModel, configuredModel);
    trace.record('model.record', { kind: 'config', detail: '[models.*] section' });

    const routingModel = effectiveModelConfig(configuredModel);
    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } =
      this.resolveProviderContext(id, routingModel, trace);
    trace.capture(TRACE.providerConfig, providerConfig);
    trace.capture(TRACE.providerName, providerName);
    trace.capture(TRACE.rawBaseUrl, rawBaseUrl);

    const protocol = this.resolveProtocol(id, routingModel, providerConfig, trace);
    const model = effectiveModelConfig(
      configuredModel,
      providerConfig?.type ?? configuredModel.protocol,
    );
    trace.capture(TRACE.effectiveModel, model);
    const wireName = model.name ?? model.model;
    const profileAttribution = profileForAttribution(configuredModel, providerConfig, wireName);
    attributeEffectiveFields(
      trace,
      configuredModel,
      model,
      profileAttribution.profile,
      profileAttribution.inferred,
    );

    const auth = resolveModelAuthMaterial(
      {
        modelId: id,
        model,
        provider: providerConfig,
        providerName,
      },
      trace,
    );
    trace.capture(TRACE.authMaterial, auth);
    const authProvider = this.buildAuthProvider(providerName, auth);

    const providerType = providerConfig?.type ?? protocol;
    const resolvedBaseUrl =
      protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    if (wireName === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const explainedCapability = this.protocolRegistry.explainCapability(
      protocol,
      wireName,
      providerType,
    );
    trace.capture(TRACE.detectedCapability, explainedCapability.capability);
    trace.capture(TRACE.capabilitySource, explainedCapability.source);
    const capabilities = resolveModelCapabilities(
      model.capabilities,
      explainedCapability.capability,
      model.maxContextSize,
    );
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
    );
    if (providerOptions !== undefined) {
      attributeProviderOptions(trace, providerOptions, providerConfig?.env);
    }
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));

    trace.capture(TRACE.hostHeaders, this.hostRequestHeaders.headers);
    return {
      id,
      name: wireName,
      aliases: model.aliases ?? [],
      protocol,
      baseUrl: resolvedBaseUrl,
      headers: resolveOutboundHeaders(
        providerConfig?.type,
        providerConfig?.customHeaders,
        this.hostRequestHeaders.headers,
      ),
      capabilities,
      maxContextSize: model.maxContextSize,
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
    trace: ResolutionTraceCollector,
  ): {
    readonly providerConfig: ProviderConfig | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string | undefined;
  } {
    const providerId =
      model.providerId ?? model.provider ?? this.config.get<string>('defaultProvider');
    if (providerId !== undefined) {
      trace.record('provider', {
        kind: 'config',
        detail:
          model.providerId !== undefined
            ? `model.providerId '${providerId}'`
            : model.provider !== undefined
              ? `model.provider '${providerId}'`
              : `[defaultProvider] '${providerId}'`,
      });
      trace.capture(TRACE.providerSynthesized, false);
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          ConfigErrors.codes.CONFIG_INVALID,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const fromModel = nonEmpty(model.baseUrl);
      const fromProvider = nonEmpty(providerConfig.baseUrl);
      let baseUrl: string | undefined;
      if (fromModel !== undefined) {
        baseUrl = fromModel;
        trace.record('resolved.baseUrl', { kind: 'config', detail: 'model.baseUrl' });
      } else if (fromProvider !== undefined) {
        baseUrl = fromProvider;
        trace.record('resolved.baseUrl', {
          kind: 'config',
          detail: `provider '${providerId}' baseUrl`,
        });
      } else {
        const endpointType = providerConfig.type ?? model.protocol;
        const endpoint =
          endpointType === undefined
            ? {}
            : explainProviderEndpoint(endpointType, providerConfig.env ?? {});
        baseUrl = nonEmpty(endpoint.baseUrl);
        if (endpoint.baseUrlEnvName !== undefined) {
          trace.record('resolved.baseUrl', {
            kind: 'env',
            detail: `${endpoint.baseUrlEnvName} (provider '${providerId}' env bag)`,
          });
        } else if (endpoint.baseUrlIsDefault === true) {
          trace.record('resolved.baseUrl', {
            kind: 'builtin',
            detail: `provider definition '${endpointType}' defaultBaseUrl`,
          });
        }
      }
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
    trace.record('provider', {
      kind: 'synthesized',
      detail: 'flat model — provider synthesized from the baseUrl host',
    });
    trace.capture(TRACE.providerSynthesized, true);
    trace.record('resolved.baseUrl', { kind: 'config', detail: 'model.baseUrl (flat)' });
    const originName = deriveProviderId(modelBaseUrl);
    return {
      providerConfig: undefined,
      providerName: originName,
      resolvedBaseUrl: modelBaseUrl,
    };
  }

  /**
   * The wire protocol: the Model's explicit `protocol` wins; otherwise the
   * referenced provider's vendor identity resolves it — directly when the
   * vendor type IS one of the four protocols, or through the vendor's first
   * registration's `baseProtocol` (e.g. `kimi` → `openai`).
   */
  private resolveProtocol(
    id: string,
    model: ModelRecord,
    provider: ProviderConfig | undefined,
    trace: ResolutionTraceCollector,
  ): Protocol {
    if (model.protocol !== undefined) {
      trace.record('resolved.protocol', { kind: 'config', detail: 'model.protocol' });
      return model.protocol;
    }
    const providerType = provider?.type;
    if (providerType !== undefined) {
      const asProtocol = ProtocolSchema.safeParse(providerType);
      if (asProtocol.success) {
        trace.record('resolved.protocol', {
          kind: 'config',
          detail: `provider type '${providerType}' is itself a wire protocol`,
        });
        return asProtocol.data;
      }
      const definition = getProviderDefinition(providerType);
      if (definition !== undefined) {
        trace.record('resolved.protocol', {
          kind: 'builtin',
          detail: `vendor '${providerType}' declared baseProtocol`,
        });
        return definition.baseProtocol;
      }
    }
    throw new Error2(
      ConfigErrors.codes.CONFIG_INVALID,
      `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
    );
  }

  private buildAuthProvider(providerName: string, auth: ResolvedModelAuthMaterial): AuthProvider {
    if (auth.apiKey !== undefined) {
      return new StaticAuthProvider(auth.apiKey);
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const oauthService = this.oauth;
      const loginRequired = (cause?: unknown): Error2 =>
        new Error2(
          AuthErrors.codes.AUTH_LOGIN_REQUIRED,
          `OAuth provider "${providerKey}" requires login before it can be used.`,
          cause === undefined ? undefined : { cause },
        );
      return {
        canRefresh: true,
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const tokenProvider = oauthService.resolveTokenProvider(providerKey, oauthRef);
          if (tokenProvider === undefined) throw loginRequired();
          const apiKey = await tokenProvider.getAccessToken(
            options?.force === true ? { force: true } : undefined,
          );
          if (apiKey.trim().length === 0) throw loginRequired();
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
  hostHeaders: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  // How much of the host identity a vendor receives is declared on its
  // provider definition (`hostHeaders: 'full'`); unregistered vendors get the
  // User-Agent only, so device identity never leaks to unknown endpoints.
  const forwardsAll =
    providerType !== undefined &&
    getProviderDefinition(providerType)?.hostHeaders === 'full';
  const hostLayer = forwardsAll ? hostHeaders : userAgentOnly(hostHeaders);
  return { ...parseKimiCodeCustomHeaders(), ...hostLayer, ...customHeaders };
}

function userAgentOnly(headers: Readonly<Record<string, string>>): Record<string, string> {
  const userAgent = headers['User-Agent'];
  return userAgent === undefined ? {} : { 'User-Agent': userAgent };
}

function resolveModelCapabilities(
  declaredCapabilities: readonly string[] | undefined,
  detected: ModelCapability,
  maxContextSize: number,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: maxContextSize,
    dynamically_loaded_tools:
      declared.has('dynamically_loaded_tools') ||
      detected.dynamically_loaded_tools === true,
  };
}

function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function buildProtocolProviderOptions(
  model: ModelRecord,
  protocol: Protocol,
  provider: ProviderConfig | undefined,
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
      break;
    }
    case 'google-genai': {
      // Vertex AI is a `providerOptions` mode of this base, not a protocol:
      // enable it when the provider env bag supplies both coordinates — the
      // same discovery legacy `protocol: 'vertexai'` configs relied on.
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

/**
 * The Anthropic effort profile the effective pass applies, recomputed for
 * attribution only — mirrors `withAnthropicProfile`'s gate exactly (the
 * trait-driven vendor check routes through the registry, never a string
 * compare). `inferred` marks the unknown-name fallback to LATEST_OPUS_PROFILE.
 */
function profileForAttribution(
  configuredModel: ModelRecord,
  providerConfig: ProviderConfig | undefined,
  wireName: string | undefined,
): { readonly profile: typeof LATEST_OPUS_PROFILE | undefined; readonly inferred: boolean } {
  if (wireName === undefined) return { profile: undefined, inferred: false };
  const profileArg = providerConfig?.type ?? configuredModel.protocol;
  const gateProtocol = configuredModel.protocol ?? profileArg;
  const known = matchKnownAnthropicModelProfile(wireName);
  const infer =
    profileArg !== undefined &&
    !drivesThinkingThroughTraits(profileArg) &&
    gateProtocol === 'anthropic';
  if (infer) return { profile: known ?? LATEST_OPUS_PROFILE, inferred: known === undefined };
  return { profile: known, inferred: false };
}

function vertexAIProject(provider: ProviderConfig | undefined): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(
  provider: ProviderConfig | undefined,
  baseUrl: string | undefined,
): string | undefined {
  return envValue(provider?.env, 'GOOGLE_CLOUD_LOCATION') ?? locationFromVertexAIBaseUrl(baseUrl);
}

function envValue(env: Record<string, string> | undefined, key: string): string | undefined {
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

/**
 * Credential detection through the provider-definition registry: the inline
 * `apiKey` wins, otherwise the vendor's declared `apiKeyEnv` chain is read
 * from the provider's config env bag.
 */
function hasConfiguredApiKey(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  if (provider.type === undefined) return false;
  return resolveProviderEndpoint(provider.type, provider.env ?? {}).apiKey !== undefined;
}

registerScopedService(
  LifecycleScope.App,
  IModelCatalog,
  ModelCatalog,
  InstantiationType.Eager,
  'modelCatalog',
);
