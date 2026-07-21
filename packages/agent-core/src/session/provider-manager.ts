import type { Logger } from '#/logging/types';
import type { ProviderConfig as KosongProviderConfig, ModelCapability, ProviderRequestAuth } from '@moonshot-ai/kosong';
import { APIStatusError, getModelCapability, UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';
import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';
import {
  effectiveModelAlias,
  type KimiConfig,
  type ModelAlias,
  type OAuthRef,
  type ProviderConfig,
  type ProviderType,
} from '../config';
import { ErrorCodes, isKimiError, KimiError } from '../errors';

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef,
) => BearerTokenProvider | undefined;

export interface ResolvedRuntimeProvider {
  readonly providerName: string;
  readonly provider: KosongProviderConfig;
  readonly modelCapabilities: ModelCapability;
  /** Declared 'always_thinking' capability — the model cannot disable thinking. */
  readonly alwaysThinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly maxOutputSize?: number;
  /** Configured provider wire type (`provider.type`), before any model-level protocol override. */
  readonly type: ProviderType;
  /** Model-level protocol override (`alias.protocol`); when set, takes precedence over `type` for transport selection. */
  readonly protocol: ModelAlias['protocol'];
}

interface ProviderManagerOptions {
  readonly config: KimiConfig | (() => KimiConfig);
  readonly kimiRequestHeaders?: Record<string, string>;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver;
  readonly promptCacheKey?: string;
}

type AuthorizedRequest = <T>(
  request: (auth: ProviderRequestAuth) => Promise<T>,
) => Promise<T>;

export interface ModelProvider {
  readonly defaultModel?: string;
  resolveProviderConfig(model: string): ResolvedRuntimeProvider;
  resolveAuth?(model: string, options?: { readonly log?: Logger }): AuthorizedRequest | undefined;
}

export class SingleModelProvider implements ModelProvider {
  constructor(
    private readonly providerConfig: KosongProviderConfig,
    private readonly modelCapabilities: ModelCapability = UNKNOWN_CAPABILITY,
  ) {}

  get defaultModel(): string {
    return this.providerConfig.model;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    if (model !== this.providerConfig.model) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not supported by SingleModelProvider.`,
      );
    }
    return {
      modelCapabilities: this.modelCapabilities,
      providerName: 'single-model-provider',
      provider: this.providerConfig,
      type: this.providerConfig.type,
      protocol: undefined,
    };
  }
}

export class ProviderManager implements ModelProvider {
  constructor(private readonly options: ProviderManagerOptions) {}

  private get config(): KimiConfig {
    const { config } = this.options;
    return typeof config === 'function' ? config() : config;
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    const alias = this.config.models?.[model];
    if (alias === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not configured in config.toml. Add a [models."${model}"] entry with max_context_size.`,
      );
    }

    const providerName = alias.provider ?? this.config.defaultProvider;
    if (providerName === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a provider in config.toml.`,
      );
    }

    const providerConfig = this.config.providers[providerName];
    if (providerConfig === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Provider "${providerName}" for model "${model}" is not configured.`,
      );
    }

    const effectiveAlias = effectiveModelAlias(alias, providerConfig.type);

    if (!Number.isInteger(effectiveAlias.maxContextSize) || effectiveAlias.maxContextSize <= 0) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a positive max_context_size in config.toml.`,
      );
    }

    const provider = toKosongProviderConfig(
      providerConfig,
      alias.model,
      alias.protocol,
      this.options.kimiRequestHeaders,
      effectiveAlias.maxOutputSize,
      effectiveAlias.reasoningKey,
      this.options.promptCacheKey,
      effectiveAlias.supportEfforts,
      effectiveAlias.adaptiveThinking,
      alias.betaApi,
    );

    return {
      providerName,
      provider,
      modelCapabilities: resolveModelCapabilities(effectiveAlias, provider),
      alwaysThinking: (effectiveAlias.capabilities ?? []).some(
        (c) => c.trim().toLowerCase() === 'always_thinking',
      ),
      supportEfforts: effectiveAlias.supportEfforts,
      defaultEffort: effectiveAlias.defaultEffort,
      maxOutputSize: effectiveAlias.maxOutputSize,
      type: providerConfig.type,
      protocol: alias.protocol,
    };
  }

  resolveAuth(
    model: string,
    options?: { readonly log?: Logger },
  ): AuthorizedRequest | undefined {
    const { providerName } = this.resolveProviderConfig(model);
    const providerConfig = this.config.providers[providerName];
    if (providerConfig?.oauth === undefined) return undefined;

    if (providerApiKey(providerConfig) !== undefined) {
      // oauth + apiKey on the same provider makes request auth ambiguous:
      // provider construction would prefer apiKey while runtime auth resolves
      // OAuth. Reject it so misconfiguration surfaces at model resolution.
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Provider "${providerName}" has both apiKey and oauth set in config.toml — they are mutually exclusive. Remove one.`,
      );
    }

    const loginRequired = (cause?: unknown): KimiError =>
      new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
        cause === undefined ? undefined : { cause },
      );

    const tokenProvider = this.options.resolveOAuthTokenProvider?.(providerName, providerConfig.oauth);
    if (tokenProvider === undefined) {
      return async () => {
        throw loginRequired();
      };
    }

    const log = options?.log;
    const fetchAuth = async (force: boolean): Promise<ProviderRequestAuth> => {
      let apiKey: string;
      try {
        apiKey = await tokenProvider.getAccessToken(force ? { force: true } : undefined);
      } catch (error) {
        // login-required is an expected state (the user must /login); don't
        // warn. Other failures (connection errors, etc.) are logged once for
        // diagnosis and then propagated — chatWithRetry does not retry them.
        if (!isKimiError(error) || error.code !== ErrorCodes.AUTH_LOGIN_REQUIRED) {
          log?.warn('oauth token fetch failed', { providerName, error });
        }
        throw error;
      }
      if (apiKey.trim().length === 0) throw loginRequired();
      return { apiKey };
    };

    return async (request) => {
      let auth = await fetchAuth(false);
      for (let refreshed = false; ; refreshed = true) {
        try {
          return await request(auth);
        } catch (error) {
          if (!(error instanceof APIStatusError) || error.statusCode !== 401) throw error;
          if (refreshed) {
            const reason = error.message.replaceAll('\r', '');
            throw new KimiError(
              ErrorCodes.PROVIDER_AUTH_ERROR,
              reason.length > 0 ? reason : 'OAuth provider credentials were rejected.',
              {
                cause: error,
                details: { statusCode: error.statusCode, requestId: error.requestId },
              },
            );
          }
          auth = await fetchAuth(true);
        }
      }
    };
  }
}

function resolveModelCapabilities(
  alias: ModelAlias,
  provider: KosongProviderConfig,
): ModelCapability {
  const declared = new Set((alias.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const detected = getModelCapability(provider.type, provider.model);

  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: alias.maxContextSize,
    // Message-level tool declarations ("dynamically loaded tools"). Every
    // field here must be merged explicitly — a capability registered in
    // kosong that is not forwarded here never reaches the agent.
    dynamically_loaded_tools:
      declared.has('dynamically_loaded_tools') ||
      detected.dynamically_loaded_tools === true,
  };
}

function toKosongProviderConfig(
  provider: ProviderConfig,
  model: string,
  modelProtocol: ModelAlias['protocol'],
  kimiRequestHeaders: Record<string, string> | undefined,
  maxOutputSize: number | undefined,
  reasoningKey: string | undefined,
  promptCacheKey: string | undefined,
  supportEfforts: readonly string[] | undefined,
  adaptiveThinking: boolean | undefined,
  betaApi: boolean | undefined,
): KosongProviderConfig {
  const effectiveType = modelProtocol === 'anthropic' ? 'anthropic' : provider.type;
  const envCustomHeaders = parseKimiCodeCustomHeaders();
  switch (effectiveType) {
    case 'anthropic': {
      const baseUrl = providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL');
      return {
        type: 'anthropic',
        model,
        baseUrl:
          modelProtocol === 'anthropic' && baseUrl !== undefined
            ? baseUrl.replace(/\/v1\/?$/, '')
            : baseUrl,
        apiKey: providerApiKey(provider),
        ...(maxOutputSize !== undefined ? { defaultMaxTokens: maxOutputSize } : {}),
        supportEfforts,
        ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
        ...(provider.type === 'kimi' ? { kimiThinking: true } : {}),
        ...(betaApi !== undefined ? { betaApi } : {}),
        // Session affinity: Anthropic's analog of OpenAI `prompt_cache_key` is
        // `metadata.user_id` on the Messages API (cache-affinity / end-user id).
        ...(promptCacheKey !== undefined ? { metadata: { user_id: promptCacheKey } } : {}),
        // When a Kimi provider is routed through the Anthropic transport
        // (`protocol: 'anthropic'`), upstream is the managed Kimi endpoint,
        // so align its full outbound identity headers (User-Agent + X-Msh-*)
        // with the Kimi OpenAI transport. Plain Anthropic providers only
        // receive the unified `User-Agent` (no `X-Msh-*` device identity),
        // matching the other non-Kimi transports. Provider `customHeaders`
        // still win on conflict.
        ...defaultHeadersField(
          provider.type === 'kimi' && modelProtocol === 'anthropic'
            ? { ...envCustomHeaders, ...kimiRequestHeaders, ...provider.customHeaders }
            : { ...envCustomHeaders, ...kimiUserAgentHeader(kimiRequestHeaders), ...provider.customHeaders },
        ),
      };
    }
    case 'openai':
      return {
        type: 'openai',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
        reasoningKey,
        // Session affinity: route every request of this session through the
        // same provider-side prompt cache (the OpenAI analog of Anthropic
        // `metadata.user_id` above). Undefined values are stripped at
        // generate time, matching the `kimi` branch below.
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...defaultHeadersField({
          ...envCustomHeaders,
          ...kimiUserAgentHeader(kimiRequestHeaders),
          ...provider.customHeaders,
        }),
      };
    case 'kimi':
      return {
        type: 'kimi',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'KIMI_BASE_URL'),
        apiKey: providerApiKey(provider),
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...defaultHeadersField({
          ...envCustomHeaders,
          ...kimiRequestHeaders,
          ...provider.customHeaders,
        }),
      };
    case 'google-genai':
      return {
        type: 'google-genai',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'GOOGLE_GEMINI_BASE_URL'),
        apiKey: providerApiKey(provider),
        ...defaultHeadersField({
          ...envCustomHeaders,
          ...kimiUserAgentHeader(kimiRequestHeaders),
          ...provider.customHeaders,
        }),
      };
    case 'openai_responses':
      return {
        type: 'openai_responses',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
        // Session affinity: same `prompt_cache_key` intent as the `openai`
        // branch; the Responses API accepts it as a top-level request field.
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...defaultHeadersField({
          ...envCustomHeaders,
          ...kimiUserAgentHeader(kimiRequestHeaders),
          ...provider.customHeaders,
        }),
      };
    case 'vertexai': {
      // Resolve the effective endpoint once (config `base_url` or the
      // GOOGLE_VERTEX_BASE_URL env fallback) and use it for BOTH forwarding and
      // location detection, so the env fallback behaves exactly like
      // `base_url` — including deriving the region from an
      // `*-aiplatform.googleapis.com` host for the service-account path.
      const baseUrl = providerValue(provider.baseUrl, provider.env, 'GOOGLE_VERTEX_BASE_URL');
      const useServiceAccount = hasVertexAIServiceEnv(provider, baseUrl);
      return {
        type: 'vertexai',
        model,
        vertexai: useServiceAccount,
        baseUrl,
        apiKey: useServiceAccount ? undefined : providerApiKey(provider),
        project: vertexAIProject(provider),
        location: vertexAILocation(provider, baseUrl),
        ...defaultHeadersField({
          ...envCustomHeaders,
          ...kimiUserAgentHeader(kimiRequestHeaders),
          ...provider.customHeaders,
        }),
      };
    }
    default: {
      const exhaustive: never = effectiveType;
      throw new KimiError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

// Returns a fresh `defaultHeaders` field for a kosong provider config so
// resolved instances never share a header object. Omits the key entirely when
// there are no headers — callers and tests rely on `'defaultHeaders' in provider`.
function defaultHeadersField(
  headers: Record<string, string> | undefined,
): { defaultHeaders?: Record<string, string> } {
  if (headers === undefined || Object.keys(headers).length === 0) return {};
  return { defaultHeaders: { ...headers } };
}

// Extract just the `User-Agent` from the Kimi identity headers so non-Kimi
// providers (OpenAI, Anthropic, Google, Vertex) also identify as
// `kimi-code-cli/<version>` without leaking the `X-Msh-*` device identity
// headers to third-party endpoints. The full `kimiRequestHeaders` set stays
// reserved for the Kimi transport (and the Kimi-routed Anthropic transport),
// where upstream is the managed Kimi endpoint.
function kimiUserAgentHeader(
  kimiRequestHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const userAgent = kimiRequestHeaders?.['User-Agent'];
  return userAgent === undefined ? {} : { 'User-Agent': userAgent };
}

function providerApiKey(provider: ProviderConfig): string | undefined {
  switch (provider.type) {
    case 'anthropic':
      return providerValue(provider.apiKey, provider.env, 'ANTHROPIC_API_KEY');
    case 'openai':
    case 'openai_responses':
      return providerValue(provider.apiKey, provider.env, 'OPENAI_API_KEY');
    case 'kimi':
      return providerValue(provider.apiKey, provider.env, 'KIMI_API_KEY');
    case 'google-genai':
      return providerValue(provider.apiKey, provider.env, 'GOOGLE_API_KEY');
    case 'vertexai':
      return (
        nonEmptyString(provider.apiKey) ??
        envValue(provider.env, 'VERTEXAI_API_KEY') ??
        envValue(provider.env, 'GOOGLE_API_KEY')
      );
    default: {
      const exhaustive: never = provider.type;
      throw new KimiError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

function hasVertexAIServiceEnv(provider: ProviderConfig, baseUrl: string | undefined): boolean {
  return vertexAIProject(provider) !== undefined && vertexAILocation(provider, baseUrl) !== undefined;
}

function vertexAIProject(provider: ProviderConfig): string | undefined {
  return envValue(provider.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(
  provider: ProviderConfig,
  baseUrl: string | undefined,
): string | undefined {
  return envValue(provider.env, 'GOOGLE_CLOUD_LOCATION') ?? locationFromVertexAIBaseUrl(baseUrl);
}

function providerValue(
  configured: string | undefined,
  env: Record<string, string> | undefined,
  envKey: string,
): string | undefined {
  return nonEmptyString(configured) ?? envValue(env, envKey);
}

function envValue(env: Record<string, string> | undefined, key: string): string | undefined {
  return nonEmptyString(env?.[key]);
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function locationFromVertexAIBaseUrl(baseUrl: string | undefined): string | undefined {
  const url = nonEmptyString(baseUrl);
  if (url === undefined) return undefined;
  try {
    const host = new URL(url).hostname;
    const suffix = '-aiplatform.googleapis.com';
    return host.endsWith(suffix) ? nonEmptyString(host.slice(0, -suffix.length)) : undefined;
  } catch {
    return undefined;
  }
}
