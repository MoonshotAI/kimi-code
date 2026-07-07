/**
 * `model` domain (L2) — `IModelResolver` implementation.
 *
 * Reads Model / Provider / Platform config, resolves the auth closure
 * (Platform.auth or Model-inline override), materializes a runnable
 * `Model` god-object via `ModelImpl`. Bound at App scope.
 *
 * Two config-driven paths:
 *   - **Structured** — `Model.providerId` points at a `[providers.*]` entry,
 *     which may point at a `[platforms.*]` entry. Auth comes from the
 *     Platform unless the Model carries an override (`apiKey` / `oauth`).
 *   - **Flat** — `Model.baseUrl` is inline; the resolver synthesizes a
 *     Provider record keyed by the URL's origin so multiple Models on the
 *     same host converge on the same Provider metadata. Auth comes from
 *     the Model itself; no Platform is required.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { ErrorCodes, KimiError } from '#/errors';
import { type ModelCapability } from '#/app/llmProtocol/capability';
import { type ProviderRequestAuth } from '#/app/llmProtocol/request';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { getModelCapability } from '#/app/llmProtocol/providers';
import { IPlatformService, UNKNOWN_PLATFORM_KEY } from '#/app/platform/platform';
import type { OAuthRef, ProviderConfig } from '#/app/provider/provider';
import { IProviderService } from '#/app/provider/provider';
import { IProtocolAdapterRegistry, type Protocol, type ProtocolProviderOptions } from '#/app/protocol/protocol';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

import type { ModelConfig } from './model';
import { IModelService } from './model';
import type { AuthProvider, Model } from './modelInstance';
import { IModelResolver } from './modelResolver';
import { ModelImpl, StaticAuthProvider } from './modelImpl';
import { resolveThinkingEffortForModel } from './thinking';

/** Shape of the `thinking` config section (owned by `profile`); only the
 *  fields the resolver needs to mirror the production default are read here. */
interface ThinkingSection {
  readonly mode?: string;
  readonly effort?: string;
}

interface ResolvedAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

type MutableProtocolProviderOptions = {
  -readonly [K in keyof ProtocolProviderOptions]: ProtocolProviderOptions[K];
};

export class ModelResolverService extends Disposable implements IModelResolver {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IProviderService private readonly providers: IProviderService,
    @IPlatformService private readonly platforms: IPlatformService,
    @IModelService private readonly models: IModelService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IProtocolAdapterRegistry
    private readonly protocolRegistry: IProtocolAdapterRegistry,
  ) {
    super();
  }

  resolve(id: string): Model {
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }
    const model = effectiveModelConfig(configuredModel);

    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } = this.resolveProviderContext(id, model);
    const auth = this.resolveAuth(id, model, providerConfig, providerName);
    const authProvider = this.buildAuthProvider(providerName, auth);

    const protocol = this.resolveProtocol(id, model, providerConfig);
    // Match production v1: strip a trailing `/v1` only when the model explicitly
    // overrides into the Anthropic transport. Native Anthropic providers keep
    // their configured `/v1` because the old provider manager did too.
    const resolvedBaseUrl =
      model.protocol === 'anthropic' ? stripTrailingV1(rawBaseUrl) : rawBaseUrl;
    const wireName = model.name ?? model.model;
    if (wireName === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must define a positive max_context_size in config.toml.`,
      );
    }

    const capabilities = resolveModelCapabilities(
      model.capabilities,
      protocol,
      wireName,
      model.maxContextSize,
    );
    const providerOptions = buildProtocolProviderOptions(
      model,
      protocol,
      providerConfig,
      resolvedBaseUrl,
    );
    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));
    const alwaysThinking = declared.has('always_thinking');

    const impl = new ModelImpl({
      id,
      name: wireName,
      aliases: model.aliases ?? [],
      protocol,
      baseUrl: resolvedBaseUrl,
      headers: providerConfig?.customHeaders ?? {},
      capabilities,
      maxContextSize: model.maxContextSize,
      maxOutputSize: model.maxOutputSize,
      displayName: model.displayName,
      reasoningKey: model.reasoningKey,
      supportEfforts: model.supportEfforts,
      defaultEffort: model.defaultEffort,
      alwaysThinking,
      providerName,
      authProvider,
      protocolRegistry: this.protocolRegistry as ProtocolAdapterRegistry,
      providerOptions,
    });

    // Apply the production default thinking effort so a plain `model.request()`
    // behaves like the agent path (which routes through `profile` and reads the
    // same `thinking` / `defaultThinking` config). Required for models whose
    // endpoint rejects a request that omits thinking (e.g. kimi-k2.7 over the
    // Anthropic protocol returns 400 unless `thinking.type === 'enabled'`).
    const effort = this.resolveDefaultThinking(model, alwaysThinking);
    return effort === 'off' ? impl : impl.withThinking(effort);
  }

  /**
   * Mirror `profile`'s `resolveThinkingLevel` / `resolveThinkingEffort` so the
   * god-object's default matches the production agent path:
   *   - an explicit `defaultThinking === false` or `thinking.mode === 'off'`
   *     turns thinking off;
   *   - otherwise the configured `thinking.effort` is used, falling back to the
   *     model's declared default effort / middle supported effort / boolean `on`;
   *   - an `always_thinking` model clamps an explicit "off" back to on.
   */
  private resolveDefaultThinking(
    model: ModelConfig,
    alwaysThinking: boolean,
  ): ThinkingEffort {
    const defaultThinking = this.config.get<boolean | undefined>('defaultThinking');
    const thinking = this.config.get<ThinkingSection | undefined>('thinking');
    return resolveThinkingEffortForModel(
      undefined,
      {
        defaultThinking,
        mode: thinking?.mode,
        effort: thinking?.effort,
      },
      { ...model, alwaysThinking },
    );
  }

  findByName(name: string): readonly string[] {
    const out: string[] = [];
    for (const [id, m] of Object.entries(this.models.list())) {
      const alias =
        m.name === name ||
        m.model === name ||
        (m.aliases ?? []).includes(name);
      if (alias) out.push(id);
    }
    return out;
  }

  /**
   * Return the ProviderConfig this Model resolves against, plus the URL to
   * hit at runtime. Structured path reads `[providers.<providerId>]`; flat
   * path synthesizes a Provider record from the Model's inline baseUrl.
   */
  private resolveProviderContext(
    id: string,
    model: ModelConfig,
  ): {
    readonly providerConfig: ProviderConfig | undefined;
    readonly providerName: string;
    readonly resolvedBaseUrl: string;
  } {
    // Structured path — Model references a Provider (which may reference a
    // Platform). Legacy configs still use `provider` in place of `providerId`.
    const providerId = model.providerId ?? model.provider;
    if (providerId !== undefined) {
      const providerConfig = this.providers.get(providerId);
      if (providerConfig === undefined) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const baseUrl =
        nonEmpty(model.baseUrl) ??
        nonEmpty(providerConfig.baseUrl) ??
        providerBaseUrlEnvFallback(
          model.protocol ?? (providerConfig.type as Protocol | undefined),
          providerConfig.env,
        );
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new KimiError(
          ErrorCodes.CONFIG_INVALID,
          `Model "${id}" (via provider "${providerId}") is missing a base URL.`,
        );
      }
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    // Flat path — Model carries its own baseUrl. Synthesize a Provider id
    // from the URL's origin so two flat Models on the same host converge.
    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
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

  private resolveProtocol(
    id: string,
    model: ModelConfig,
    provider: ProviderConfig | undefined,
  ): Protocol {
    const explicit = model.protocol ?? (provider?.type as Protocol | undefined);
    if (explicit === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
      );
    }
    return explicit;
  }

  /**
   * Resolve raw auth material for the Model. Precedence:
   *   1. Model-inline `apiKey` / `oauth` (flat-case override).
   *   2. Provider.platformId → Platform.auth (structured shared auth).
   *   3. Provider-legacy `apiKey` / `oauth` (pre-migration configs).
   *
   * An empty / whitespace `apiKey` is treated as absent (matching production's
   * `nonEmptyString`), so a provider that carries both `api_key = ""` and an
   * `oauth` block correctly falls through to OAuth instead of producing an
   * empty bearer token.
   */
  private resolveAuth(
    id: string,
    model: ModelConfig,
    provider: ProviderConfig | undefined,
    providerName: string,
  ): ResolvedAuthMaterial {
    const modelApiKey = nonEmpty(model.apiKey);
    if (modelApiKey !== undefined && model.oauth !== undefined) {
      throw authConflictError('Model', id);
    }
    if (modelApiKey !== undefined) return { apiKey: modelApiKey };
    if (model.oauth !== undefined) {
      return { oauth: model.oauth, oauthProviderKey: model.providerId ?? model.provider };
    }

    const platformId = provider?.platformId;
    if (platformId !== undefined && platformId !== UNKNOWN_PLATFORM_KEY) {
      const platform = this.platforms.get(platformId);
      const authType = provider?.type ?? model.protocol;
      const platformApiKey =
        nonEmpty(platform?.auth?.apiKey) ??
        providerApiKeyEnvFallback(authType, platform?.auth?.env);
      if (platformApiKey !== undefined && platform?.auth?.oauth !== undefined) {
        throw authConflictError('Platform', platformId);
      }
      if (platformApiKey !== undefined) return { apiKey: platformApiKey };
      if (platform?.auth?.oauth !== undefined) {
        return {
          oauth: platform.auth.oauth,
          oauthProviderKey: platformId,
        };
      }
    }

    // Legacy: provider carried auth directly (pre-Phase 4 migration).
    const providerApiKey =
      nonEmpty(provider?.apiKey) ??
      providerApiKeyEnvFallback(provider?.type ?? model.protocol, provider?.env);
    if (providerApiKey !== undefined && provider?.oauth !== undefined) {
      throw authConflictError('Provider', providerName);
    }
    if (providerApiKey !== undefined) return { apiKey: providerApiKey };
    if (provider?.oauth !== undefined) {
      return { oauth: provider.oauth, oauthProviderKey: model.providerId ?? model.provider };
    }
    return {};
  }

  private buildAuthProvider(providerName: string, auth: ResolvedAuthMaterial): AuthProvider {
    if (auth.apiKey !== undefined) {
      return new StaticAuthProvider(auth.apiKey);
    }
    if (auth.oauth !== undefined) {
      const oauthRef = auth.oauth;
      const providerKey = auth.oauthProviderKey ?? providerName;
      const oauthService = this.oauth;
      const loginRequired = (cause?: unknown): KimiError =>
        new KimiError(
          ErrorCodes.AUTH_LOGIN_REQUIRED,
          `OAuth provider "${providerKey}" requires login before it can be used.`,
          cause === undefined ? undefined : { cause },
        );
      return {
        canRefresh: true,
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const tokenProvider = oauthService.resolveTokenProvider(providerKey, oauthRef);
          if (tokenProvider === undefined) throw loginRequired();
          const apiKey = await tokenProvider.getAccessToken({ force: options?.force ?? false });
          if (apiKey.trim().length === 0) throw loginRequired();
          return { apiKey };
        },
      };
    }
    return new StaticAuthProvider(undefined);
  }
}

function resolveModelCapabilities(
  declaredCapabilities: readonly string[] | undefined,
  protocol: Protocol,
  wireName: string,
  maxContextSize: number,
): ModelCapability {
  const declared = new Set((declaredCapabilities ?? []).map((c) => c.trim().toLowerCase()));
  const detected = getModelCapability(protocol, wireName);
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: maxContextSize,
    select_tools: declared.has('select_tools') || detected.select_tools === true,
  };
}

/** Treat an empty / whitespace string as absent (matches production's
 *  `nonEmptyString` used by the session resolver). */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Strip a trailing `/v1` (with optional trailing slash) from a baseUrl, matching
 *  production v1's anthropic-transport normalization so the Anthropic SDK's
 *  `/v1/messages` suffix does not produce a double `/v1/v1/messages`. */
function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function effectiveModelConfig(model: ModelConfig): ModelConfig {
  const { overrides, ...base } = model;
  if (overrides === undefined) return model;
  const effective: ModelConfig = { ...base, ...overrides };
  if (
    overrides.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }
  return effective;
}

function authConflictError(kind: string, name: string): KimiError {
  return new KimiError(
    ErrorCodes.CONFIG_INVALID,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}

function buildProtocolProviderOptions(
  model: ModelConfig,
  protocol: Protocol,
  provider: ProviderConfig | undefined,
  baseUrl: string,
): ProtocolProviderOptions | undefined {
  const options: MutableProtocolProviderOptions = {};

  switch (protocol) {
    case 'anthropic':
      if (model.maxOutputSize !== undefined) options.defaultMaxTokens = model.maxOutputSize;
      if (model.adaptiveThinking !== undefined) options.adaptiveThinking = model.adaptiveThinking;
      if (model.betaApi !== undefined) options.betaApi = model.betaApi;
      break;
    case 'openai': {
      const reasoningKey = nonEmpty(model.reasoningKey);
      if (reasoningKey !== undefined) options.reasoningKey = reasoningKey;
      break;
    }
    case 'kimi':
      if (model.supportEfforts !== undefined) options.supportEfforts = model.supportEfforts;
      break;
    case 'vertexai': {
      const project = vertexAIProject(provider);
      const location = vertexAILocation(provider, baseUrl);
      options.vertexai = project !== undefined && location !== undefined;
      if (project !== undefined) options.project = project;
      if (location !== undefined) options.location = location;
      break;
    }
    case 'google-genai':
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

function providerBaseUrlEnvFallback(
  protocol: Protocol | undefined,
  env: Record<string, string> | undefined,
): string | undefined {
  if (protocol === undefined) return undefined;
  switch (protocol) {
    case 'anthropic':
      return envValue(env, 'ANTHROPIC_BASE_URL');
    case 'openai':
    case 'openai_responses':
      return envValue(env, 'OPENAI_BASE_URL');
    case 'kimi':
      return envValue(env, 'KIMI_BASE_URL');
    case 'google-genai':
      return envValue(env, 'GOOGLE_GEMINI_BASE_URL');
    case 'vertexai':
      return envValue(env, 'GOOGLE_VERTEX_BASE_URL');
    default: {
      const exhaustive: never = protocol;
      return exhaustive;
    }
  }
}

function providerApiKeyEnvFallback(
  protocol: Protocol | undefined,
  env: Record<string, string> | undefined,
): string | undefined {
  if (protocol === undefined) return undefined;
  switch (protocol) {
    case 'anthropic':
      return envValue(env, 'ANTHROPIC_API_KEY');
    case 'openai':
    case 'openai_responses':
      return envValue(env, 'OPENAI_API_KEY');
    case 'kimi':
      return envValue(env, 'KIMI_API_KEY');
    case 'google-genai':
      return envValue(env, 'GOOGLE_API_KEY');
    case 'vertexai':
      return envValue(env, 'VERTEXAI_API_KEY') ?? envValue(env, 'GOOGLE_API_KEY');
    default: {
      const exhaustive: never = protocol;
      return exhaustive;
    }
  }
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
 * Derive a synthetic Provider id from a Model's flat baseUrl. Uses only the
 * origin (host, optionally port) per Phase 2 decision "a=origin only" — two
 * flat Models hitting the same host converge on one Provider identity.
 */
function deriveProviderId(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    // Fall back to the raw string; malformed URLs will fail downstream at
    // request time with a clearer error.
    return baseUrl;
  }
}

registerScopedService(
  LifecycleScope.App,
  IModelResolver,
  ModelResolverService,
  InstantiationType.Delayed,
  'modelResolver',
);
