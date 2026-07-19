/**
 * `kosong/model` domain (L2) — `ModelCatalog`, the single place that builds
 * Models.
 *
 * Reads Model / Provider / Platform config, resolves the auth closure
 * (Platform.auth or Model-inline override), and assembles the pure-data
 * `Model` plus its `ModelRequester` — cached together by model id. Bound at
 * App scope; resolution is shared across sessions.
 *
 * Two config-driven paths (unchanged from the legacy resolver):
 *   - **Structured** — `Model.providerId` points at a `[providers.*]` entry,
 *     which may point at a `[platforms.*]` entry. Auth comes from the
 *     Platform unless the Model carries an override (`apiKey` / `oauth`).
 *   - **Flat** — `Model.baseUrl` is inline; the catalog synthesizes a
 *     Provider record keyed by the URL's origin so multiple Models on the
 *     same host converge on the same Provider metadata. Auth comes from the
 *     Model itself; no Platform is required.
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
 * model/provider/platform config-change events. Tests that mutate config
 * behind the services' backs (bypassing those events) must call
 * `notifyConfigChanged()` to drop the cache — otherwise `get` keeps serving
 * the previous generation's Model.
 */

import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import { IPlatformService } from '#/app/platform/platform';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import {
  IProtocolAdapterRegistry,
  ProtocolSchema,
  type Protocol,
  type ProtocolProviderOptions,
} from '#/kosong/protocol/protocol';

import { IConfigService } from '../../app/config/config';
import { ConfigErrors } from '../../app/config/errors';
import { IProviderService, type ProviderConfig } from '../provider/provider';
import {
  getProviderDefinition,
  resolveProviderEndpoint,
} from '../provider/providerDefinition';

import {
  type AuthProvider,
  IModelCatalog,
  type Model,
  StaticAuthProvider,
} from './catalog';
import { IHostRequestHeaders } from './hostRequestHeaders';
import { IModelService, type ModelRecord } from './model';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
  type ResolvedModelAuthMaterial,
} from './modelAuth';
import type { ModelRequester } from './modelRequester';
import { ModelRequesterImpl } from './modelRequesterImpl';

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
    @IConfigService private readonly config: IConfigService,
    @IProviderService private readonly providers: IProviderService,
    @IPlatformService private readonly platforms: IPlatformService,
    @IModelService private readonly models: IModelService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
  ) {
    super();
    // Cache invalidation rides the three config-change events; any change in
    // any of them can alter an assembled Model, so the whole cache drops.
    this._register(this.models.onDidChangeModels(() => this.notifyConfigChanged()));
    this._register(this.providers.onDidChangeProviders(() => this.notifyConfigChanged()));
    this._register(this.platforms.onDidChangePlatforms(() => this.notifyConfigChanged()));
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
    const model = this.buildModel(id);
    const entry: CatalogEntry = {
      model,
      requester: new ModelRequesterImpl(model, this.protocolRegistry),
    };
    this.cache.set(id, entry);
    return entry;
  }

  private buildModel(id: string): Model {
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }
    const routingModel = effectiveModelConfig(configuredModel);
    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } =
      this.resolveProviderContext(id, routingModel);
    const protocol = this.resolveProtocol(id, routingModel, providerConfig);
    const model = effectiveModelConfig(
      configuredModel,
      providerConfig?.type ?? configuredModel.protocol,
    );
    const auth = resolveModelAuthMaterial({
      modelId: id,
      model,
      provider: providerConfig,
      providerName,
      getPlatform: (platformId) => this.platforms.get(platformId),
    });
    const authProvider = this.buildAuthProvider(providerName, auth);

    const providerType = providerConfig?.type ?? protocol;
    const resolvedBaseUrl =
      protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    const wireName = model.name ?? model.model;
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

    const capabilities = resolveModelCapabilities(
      model.capabilities,
      this.protocolRegistry.resolveCapability(protocol, wireName, providerType),
      model.maxContextSize,
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
  ): {
    readonly providerConfig: ProviderConfig | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string | undefined;
  } {
    const providerId =
      model.providerId ?? model.provider ?? this.config.get<string>('defaultProvider');
    if (providerId !== undefined) {
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new Error2(
          ConfigErrors.codes.CONFIG_INVALID,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const baseUrl =
        nonEmpty(model.baseUrl) ??
        nonEmpty(providerConfig.baseUrl) ??
        providerBaseUrlEnvFallback(providerConfig.type ?? model.protocol, providerConfig.env);
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new Error2(
        ConfigErrors.codes.CONFIG_INVALID,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
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
  ): Protocol {
    if (model.protocol !== undefined) return model.protocol;
    const providerType = provider?.type;
    if (providerType !== undefined) {
      const asProtocol = ProtocolSchema.safeParse(providerType);
      if (asProtocol.success) return asProtocol.data;
      const definition = getProviderDefinition(providerType);
      if (definition !== undefined) return definition.baseProtocol;
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
 * Env-bag baseUrl fallback through the provider-definition registry (the
 * vendor's declared `baseUrlEnv` → `defaultBaseUrl` chain). Unregistered
 * vendors get no config-level fallback; their bases fall back to
 * `process.env` at construction.
 */
function providerBaseUrlEnvFallback(
  providerType: string | undefined,
  env: Record<string, string> | undefined,
): string | undefined {
  if (providerType === undefined) return undefined;
  return nonEmpty(resolveProviderEndpoint(providerType, env ?? {}).baseUrl);
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

registerScopedService(
  LifecycleScope.App,
  IModelCatalog,
  ModelCatalog,
  InstantiationType.Eager,
  'modelCatalog',
);
