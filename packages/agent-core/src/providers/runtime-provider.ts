import type { KimiConfig, ModelAlias, OAuthRef, ProviderConfig } from '#/config';
import { ErrorCodes, KimiError, isKimiError } from '#/errors';
import { log as defaultLog } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ModelCapability,
  type ProviderConfig as KosongProviderConfig,
} from '@moonshot-ai/kosong';

import type { ProviderRequestAuthResolver } from './request-auth';

export type { ProviderRequestAuthResolver };

export interface ResolveRuntimeProviderInput {
  readonly config: KimiConfig;
  readonly model?: string | undefined;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly promptCacheKey?: string;
  readonly validateCredentials?: boolean;
}

export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean | undefined }): Promise<string>;
}

export type OAuthTokenProviderResolver = (
  providerName: string,
  oauthRef?: OAuthRef | undefined,
) => BearerTokenProvider | undefined;

export interface ResolveRuntimeProviderWithOAuthInput extends ResolveRuntimeProviderInput {
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  /**
   * Caller-scoped logger (typically `agent.log`). Used to report OAuth token
   * fetch failures so they land in the session log alongside the surrounding
   * turn / tool call. Defaults to the global `log` when absent.
   */
  readonly log?: Logger;
}

export interface ResolvedRuntimeProvider {
  readonly modelName: string;
  readonly providerName?: string | undefined;
  readonly provider: KosongProviderConfig;
  readonly modelCapabilities: ModelCapability;
  readonly resolveAuth?: ProviderRequestAuthResolver;
}

export function resolveRuntimeProvider(
  input: ResolveRuntimeProviderInput,
): ResolvedRuntimeProvider {
  const modelName = input.model ?? input.config.defaultModel;
  if (modelName === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      'No model is selected. Set default_model in config.toml or pass a configured model alias.',
    );
  }

  const alias = input.config.models?.[modelName];
  if (alias === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Model "${modelName}" is not configured in config.toml. Add a [models."${modelName}"] entry with max_context_size.`,
    );
  }

  const resolvedModel = alias.model;
  const providerName = alias.provider ?? input.config.defaultProvider;
  const providerConfig =
    providerName === undefined ? undefined : input.config.providers[providerName];

  if (providerName === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Model "${modelName}" must define a provider in config.toml.`,
    );
  }

  if (providerConfig === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Provider "${providerName}" for model "${modelName}" is not configured.`,
    );
  }

  if (!Number.isInteger(alias.maxContextSize) || alias.maxContextSize <= 0) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Model "${modelName}" must define a positive max_context_size in config.toml.`,
    );
  }

  // Fail-fast when an operation explicitly selects/uses a runtime provider.
  // Session creation only records the selected model name and does not need
  // credential validation.
  if (
    input.validateCredentials !== false &&
    providerConfig.type !== 'vertexai' &&
    providerConfig.oauth === undefined &&
    providerApiKey(providerConfig) === undefined
  ) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Provider "${providerName}" has no credentials configured. Set apiKey, oauth, or a provider env API key in config.toml.`,
    );
  }

  const provider = toKosongProviderConfig(
    providerConfig,
    resolvedModel,
    input.kimiRequestHeaders,
    alias.maxOutputSize,
    alias.reasoningKey,
    input.promptCacheKey,
  );
  const modelCapabilities = resolveModelCapabilities(alias, provider);

  return {
    modelName,
    providerName,
    modelCapabilities,
    provider,
  };
}

export async function resolveRuntimeProviderWithOAuth(
  input: ResolveRuntimeProviderWithOAuthInput,
): Promise<ResolvedRuntimeProvider> {
  const resolved = resolveRuntimeProvider(input);
  const resolveAuth = createRuntimeProviderAuthResolver(input, resolved);
  if (resolveAuth === undefined) return resolved;

  // Validate login eagerly, preserving existing setModel
  // behavior, but do not store the short-lived token in provider config.
  await resolveAuth();
  return {
    ...resolved,
    resolveAuth,
  };
}

export function createRuntimeProviderAuthResolver(
  input: ResolveRuntimeProviderWithOAuthInput,
  resolved: ResolvedRuntimeProvider = resolveRuntimeProvider(input),
): ProviderRequestAuthResolver | undefined {
  const providerName = resolved.providerName;
  if (providerName === undefined) return undefined;

  const providerConfig = input.config.providers[providerName];
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

  const tokenProvider = input.resolveOAuthTokenProvider?.(providerName, providerConfig.oauth);
  if (tokenProvider === undefined) {
    return async () => {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
      );
    };
  }

  return async (options) => {
    let apiKey: string;
    try {
      apiKey = await tokenProvider.getAccessToken(
        options?.forceRefresh === true ? { force: true } : undefined,
      );
    } catch (error) {
      if (!isAuthLoginRequired(error)) {
        (input.log ?? defaultLog).warn('oauth token fetch failed', { providerName, error });
      }
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
        {
          cause: error,
        },
      );
    }
    if (apiKey.trim().length === 0) {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
      );
    }
    return { apiKey };
  };
}

function isAuthLoginRequired(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED;
}

function resolveModelCapabilities(
  alias: ModelAlias & { maxContextSize: number },
  provider: KosongProviderConfig,
): ModelCapability {
  const capabilities = new Set(
    (alias.capabilities ?? []).map((capability) => capability.trim().toLowerCase()),
  );
  const has = (capability: string): boolean => capabilities.has(capability);
  const capabilityProvider = createProvider(providerForCapabilityProbe(provider));
  const providerCapability =
    capabilityProvider.getCapability?.(provider.model) ?? UNKNOWN_CAPABILITY;

  return {
    image_in: has('image_in') || providerCapability.image_in,
    video_in: has('video_in') || providerCapability.video_in,
    audio_in: has('audio_in') || providerCapability.audio_in,
    thinking: has('thinking') || has('always_thinking') || providerCapability.thinking,
    tool_use: has('tool_use') || providerCapability.tool_use,
    max_context_tokens: alias.maxContextSize,
  };
}

function toKosongProviderConfig(
  provider: ProviderConfig,
  model: string,
  kimiRequestHeaders?: Record<string, string> | undefined,
  maxOutputSize?: number | undefined,
  reasoningKey?: string | undefined,
  promptCacheKey?: string,
): KosongProviderConfig {
  switch (provider.type) {
    case 'anthropic':
      return {
        type: 'anthropic',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL'),
        apiKey: providerApiKey(provider),
        ...(maxOutputSize !== undefined ? { defaultMaxTokens: maxOutputSize } : {}),
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
    case 'kimi': {
      const defaultHeaders = {
        ...kimiRequestHeaders,
        ...provider.customHeaders,
      };
      if (Object.keys(defaultHeaders).length === 0) {
        return {
          type: 'kimi',
          model,
          baseUrl: providerValue(provider.baseUrl, provider.env, 'KIMI_BASE_URL'),
          generationKwargs: {
            prompt_cache_key: promptCacheKey,
          },
          apiKey: providerApiKey(provider),
        };
      }
      return {
        type: 'kimi',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'KIMI_BASE_URL'),
        generationKwargs: {
          prompt_cache_key: promptCacheKey,
        },
        defaultHeaders,
        apiKey: providerApiKey(provider),
      };
    }
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
    case 'vertexai':
      return {
        type: 'vertexai',
        model,
        vertexai: hasVertexAIServiceEnv(provider),
        apiKey: hasVertexAIServiceEnv(provider) ? undefined : providerApiKey(provider),
        project: vertexAIProject(provider),
        location: vertexAILocation(provider),
      };
    default: {
      const exhaustive: never = provider.type;
      throw new KimiError(
        ErrorCodes.MODEL_CONFIG_INVALID,
        `Unsupported provider type: ${String(exhaustive)}`,
      );
    }
  }
}

// Spread-ready `defaultHeaders` field for a kosong provider config. Returns a
// fresh copy so resolved provider instances never share a header object, and
// omits the key entirely when there are no headers (callers and tests rely on
// `'defaultHeaders' in provider`).
function defaultHeadersField(
  headers: Record<string, string> | undefined,
): { defaultHeaders?: Record<string, string> } {
  if (headers === undefined || Object.keys(headers).length === 0) return {};
  return { defaultHeaders: { ...headers } };
}

function providerForCapabilityProbe(provider: KosongProviderConfig): KosongProviderConfig {
  if (provider.type === 'vertexai') {
    return {
      ...provider,
      vertexai: false,
      project: undefined,
      location: undefined,
      apiKey:
        provider.apiKey === undefined || provider.apiKey.length === 0
          ? 'capability-probe'
          : provider.apiKey,
    };
  }
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) return provider;
  return { ...provider, apiKey: 'capability-probe' };
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
