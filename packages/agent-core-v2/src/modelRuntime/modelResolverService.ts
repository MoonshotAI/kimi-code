/**
 * `modelRuntime` domain (L3) — `IModelResolver` runtime implementation.
 *
 * Resolves a model alias into a runtime provider configuration plus optional
 * OAuth request authorization, reading provider / model configuration through
 * `IConfigService` and OAuth tokens through `IOAuthService`. Registered as a
 * Session-scoped service; `modelResolverSeed` remains a host/test override seam.
 */

import type {
  ModelCapability,
  ProviderConfig as RuntimeProviderConfig,
  ProviderRequestAuth,
} from '@moonshot-ai/kosong';
import {
  APIStatusError,
  getModelCapability,
  UNKNOWN_CAPABILITY,
} from '@moonshot-ai/kosong';

import { InstantiationType } from '#/_base/di/extensions';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService, type ScopeSeed } from '#/_base/di/scope';
import { IOAuthService } from '#/auth';
import { IConfigService } from '#/config';
import { ErrorCodes, isKimiError, KimiError } from '#/errors';
import type { ModelAlias } from '#/model';
import type { ProviderConfig } from '#/provider';

import {
  type AuthorizedRequest,
  IModelResolver,
  type RequestLogger,
  type ResolvedModel,
} from './modelRuntime';

export function modelResolverSeed(modelResolver: IModelResolver): ScopeSeed {
  return [[IModelResolver as ServiceIdentifier<unknown>, modelResolver]];
}

export class SingleModelResolver implements IModelResolver {
  declare readonly _serviceBrand: undefined;
  constructor(
    private readonly providerConfig: RuntimeProviderConfig,
    private readonly modelCapabilities: ModelCapability = UNKNOWN_CAPABILITY,
  ) {}

  get defaultModel(): string {
    return this.providerConfig.model;
  }

  resolve(model: string): ResolvedModel {
    if (model !== this.providerConfig.model) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not supported by SingleModelResolver.`,
      );
    }
    return {
      modelCapabilities: this.modelCapabilities,
      providerName: 'single-model-resolver',
      provider: this.providerConfig,
    };
  }
}

export class ModelResolver implements IModelResolver {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
  ) {}

  get defaultModel(): string | undefined {
    return this.config.get<string>('defaultModel');
  }

  private get models(): Record<string, ModelAlias> {
    return this.config.get<Record<string, ModelAlias>>('models') ?? {};
  }

  private get providers(): Record<string, ProviderConfig> {
    return this.config.get<Record<string, ProviderConfig>>('providers') ?? {};
  }

  private get defaultProvider(): string | undefined {
    return this.config.get<string>('defaultProvider');
  }

  resolve(model: string): ResolvedModel {
    const alias = this.models[model];
    if (alias === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" is not configured in config.toml. Add a [models."${model}"] entry with max_context_size.`,
      );
    }

    const providerName = alias.provider ?? this.defaultProvider;
    if (providerName === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${model}" must define a provider in config.toml.`,
      );
    }

    const providerConfig = this.providers[providerName];
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

    const provider = toRuntimeProviderConfig(
      providerConfig,
      alias.model,
      alias.maxOutputSize,
      alias.reasoningKey,
      alias.adaptiveThinking,
    );

    return {
      providerName,
      provider,
      modelCapabilities: resolveModelCapabilities(alias, provider),
      alwaysThinking: (alias.capabilities ?? []).some(
        (capability) => capability.trim().toLowerCase() === 'always_thinking',
      ),
      maxOutputSize: alias.maxOutputSize,
    };
  }

  resolveAuth(
    model: string,
    options?: { readonly log?: RequestLogger },
  ): AuthorizedRequest | undefined {
    const { providerName } = this.resolve(model);
    const providerConfig = this.providers[providerName];
    if (providerConfig?.oauth === undefined) return undefined;

    if (providerApiKey(providerConfig) !== undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Provider "${providerName}" has both apiKey and oauth set in config.toml.`,
      );
    }

    const loginRequired = (cause?: unknown): KimiError =>
      new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        `OAuth provider "${providerName}" requires login before it can be used.`,
        cause === undefined ? undefined : { cause },
      );

    const tokenProvider = this.oauth.resolveTokenProvider(providerName, providerConfig.oauth);
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
  provider: RuntimeProviderConfig,
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

function toRuntimeProviderConfig(
  provider: ProviderConfig,
  model: string,
  maxOutputSize: number | undefined,
  reasoningKey: string | undefined,
  adaptiveThinking: boolean | undefined,
  kimiRequestHeaders?: Record<string, string>,
  promptCacheKey?: string,
): RuntimeProviderConfig {
  switch (provider.type) {
    case 'anthropic':
      return {
        type: 'anthropic',
        model,
        baseUrl: providerValue(provider.baseUrl, provider.env, 'ANTHROPIC_BASE_URL'),
        apiKey: providerApiKey(provider),
        defaultMaxTokens: maxOutputSize,
        adaptiveThinking,
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

registerScopedService(
  LifecycleScope.Session,
  IModelResolver,
  ModelResolver,
  InstantiationType.Delayed,
  'modelRuntime',
);
