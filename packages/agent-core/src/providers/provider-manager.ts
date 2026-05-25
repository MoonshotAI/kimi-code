import type { KimiConfig } from '../config';
import { ErrorCodes, KimiError } from '#/errors';
import type { Logger } from '#/logging/types';
import { resolveThinkingEffort, type ThinkingEffort } from '../agent/config/thinking';
import {
  createRuntimeProviderAuthResolver,
  resolveRuntimeProvider,
  resolveRuntimeProviderWithOAuth,
  type OAuthTokenProviderResolver,
  type ProviderRequestAuthResolver,
  type ResolvedRuntimeProvider,
} from './runtime-provider';

export interface ProviderManagerOptions {
  readonly config: KimiConfig;
  readonly kimiRequestHeaders?: Record<string, string> | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly promptCacheKey?: string;
}

export class ProviderManager {
  private readonly state: ProviderManagerState;

  constructor(
    private readonly options: ProviderManagerOptions,
    state?: ProviderManagerState,
  ) {
    this.state = state ?? { config: options.config };
  }

  get config(): KimiConfig {
    return this.state.config;
  }

  get providers(): KimiConfig['providers'] {
    return this.state.config.providers;
  }

  get models(): NonNullable<KimiConfig['models']> {
    return this.state.config.models ?? {};
  }

  updateConfig(config: KimiConfig): void {
    this.state.config = config;
  }

  withPromptCacheKey(promptCacheKey?: string): ProviderManager {
    return new ProviderManager(
      {
        ...this.options,
        config: this.state.config,
        promptCacheKey,
      },
      this.state,
    );
  }

  resolveProviderConfigForModel(
    model: string | undefined,
    options?: { readonly promptCacheKey?: string },
  ): ResolvedRuntimeProvider | undefined {
    const selectedModel = this.resolveSelectedModel(model);
    if (selectedModel === undefined) return undefined;

    return resolveRuntimeProvider({
      config: this.state.config,
      model: selectedModel,
      kimiRequestHeaders: this.options.kimiRequestHeaders,
      promptCacheKey: options?.promptCacheKey ?? this.options.promptCacheKey,
      validateCredentials: false,
    });
  }

  async resolveProviderForModel(
    model: string | undefined,
  ): Promise<ResolvedRuntimeProvider | undefined> {
    const selectedModel = this.resolveSelectedModel(model);
    if (selectedModel === undefined) return undefined;

    return resolveRuntimeProviderWithOAuth({
      config: this.state.config,
      model: selectedModel,
      kimiRequestHeaders: this.options.kimiRequestHeaders,
      promptCacheKey: this.options.promptCacheKey,
      resolveOAuthTokenProvider: this.options.resolveOAuthTokenProvider,
    });
  }

  createAuthResolverForModel(
    model: string | undefined,
    options?: { readonly log?: Logger },
  ): ProviderRequestAuthResolver | undefined {
    const selectedModel = this.resolveSelectedModel(model);
    if (selectedModel === undefined) return undefined;

    const resolved = resolveRuntimeProvider({
      config: this.state.config,
      model: selectedModel,
      kimiRequestHeaders: this.options.kimiRequestHeaders,
      promptCacheKey: this.options.promptCacheKey,
    });
    return createRuntimeProviderAuthResolver(
      {
        config: this.state.config,
        model: selectedModel,
        kimiRequestHeaders: this.options.kimiRequestHeaders,
        promptCacheKey: this.options.promptCacheKey,
        resolveOAuthTokenProvider: this.options.resolveOAuthTokenProvider,
        log: options?.log,
      },
      resolved,
    );
  }

  resolveThinkingLevel(requestedThinking?: string): ThinkingEffort {
    return resolveThinkingEffort(
      requestedThinking ?? defaultThinkingDisableOverride(this.state.config.defaultThinking),
      this.state.config.thinking,
    );
  }

  resolveSelectedModel(requestedModel: string | undefined): string | undefined {
    if (requestedModel !== undefined) {
      const normalized = normalizeString(requestedModel);
      if (normalized === undefined) {
        throw new KimiError(ErrorCodes.MODEL_CONFIG_INVALID, 'Runtime provider model cannot be empty');
      }
      return normalized;
    }
    return normalizeString(this.state.config.defaultModel);
  }
}

interface ProviderManagerState {
  config: KimiConfig;
}

function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultThinkingDisableOverride(defaultThinking: boolean | undefined): string | undefined {
  return defaultThinking === false ? 'off' : undefined;
}
