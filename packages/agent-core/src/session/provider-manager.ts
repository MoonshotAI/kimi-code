import type { Logger } from '#/logging/types';
import type { ProviderConfig as KosongProviderConfig, ModelCapability, ProviderRequestAuth } from '@moonshot-ai/kosong';
import { APIStatusError, getModelCapability, UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';
import type { KimiConfig, ModelAlias, OAuthRef, ProviderConfig } from '../config';
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
  readonly maxOutputSize?: number;
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

    if (!Number.isInteger(alias.maxContextSize) || alias.maxContextSize <= 0) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a positive max_context_size in config.toml.`,
      );
    }

    const provider = toKosongProviderConfig(
      providerConfig,
      alias.model,
      this.options.kimiRequestHeaders,
      alias.maxOutputSize,
      alias.reasoningKey,
      this.options.promptCacheKey,
      alias.adaptiveThinking,
    );

    return {
      providerName,
      provider,
      modelCapabilities: resolveModelCapabilities(alias, provider),
      alwaysThinking: (alias.capabilities ?? []).some(
        (c) => c.trim().toLowerCase() === 'always_thinking',
      ),
      maxOutputSize: alias.maxOutputSize,
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
        if (!isKimiError(error) || error.code !== ErrorCodes.AUTH_LOGIN_REQUIRED) {
          log?.warn('oauth token fetch failed', { providerName, error });
        }
        throw loginRequired(error);
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
            throw new KimiError(
              ErrorCodes.AUTH_LOGIN_REQUIRED,
              'OAuth provider credentials were rejected. Send /login to login.',
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
  };
}

function toKosongProviderConfig(
  provider: ProviderConfig,
  model: string,
  kimiRequestHeaders: Record<string, string> | undefined,
  maxOutputSize: number | undefined,
  reasoningKey: string | undefined,
  promptCacheKey: string | undefined,
  adaptiveThinking: boolean | undefined,
): KosongProviderConfig {
  switch (provider.type) {
    case 'anthropic':
      return {
        type: 'anthropic',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL'),
        apiKey: providerApiKey(provider),
        ...(maxOutputSize !== undefined ? { defaultMaxTokens: maxOutputSize } : {}),
        ...(adaptiveThinking !== undefined ? { adaptiveThinking } : {}),
        ...defaultHeadersField(provider.customHeaders),
      };
    case 'openai':
      return {
        type: 'openai',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
        reasoningKey,
        ...defaultHeadersField(provider.customHeaders),
      };
    case 'kimi':
      return {
        type: 'kimi',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'KIMI_BASE_URL'),
        apiKey: providerApiKey(provider),
        generationKwargs: { prompt_cache_key: promptCacheKey },
        ...defaultHeadersField({ ...kimiRequestHeaders, ...provider.customHeaders }),
      };
    case 'google-genai':
      return {
        type: 'google-genai',
        model,
        apiKey: providerApiKey(provider),
      };
    case 'openai_responses':
      return {
        type: 'openai_responses',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'OPENAI_BASE_URL'),
        apiKey: providerApiKey(provider),
        ...defaultHeadersField(provider.customHeaders),
      };
    case 'vertexai': {
      const useServiceAccount = hasVertexAIServiceEnv(provider);
      return {
        type: 'vertexai',
        model,
        vertexai: useServiceAccount,
        apiKey: useServiceAccount ? undefined : providerApiKey(provider),
        project: vertexAIProject(provider),
        location: vertexAILocation(provider),
      };
    }
    default: {
      const exhaustive: never = provider.type;
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

function hasVertexAIServiceEnv(provider: ProviderConfig): boolean {
  return vertexAIProject(provider) !== undefined && vertexAILocation(provider) !== undefined;
}

function vertexAIProject(provider: ProviderConfig): string | undefined {
  return envValue(provider.env, 'GOOGLE_CLOUD_PROJECT');
}

function vertexAILocation(provider: ProviderConfig): string | undefined {
  return (
    envValue(provider.env, 'GOOGLE_CLOUD_LOCATION') ??
    locationFromVertexAIBaseUrl(provider.baseUrl)
  );
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
