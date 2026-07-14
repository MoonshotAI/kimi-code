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

import { parseKimiCodeCustomHeaders } from '@moonshot-ai/kimi-code-oauth';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { ErrorCodes, Error2 } from '#/errors';
import { type ModelCapability } from '#/app/llmProtocol/capability';
import { type ProviderRequestAuth } from '#/app/llmProtocol/request';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { getModelCapability } from '#/app/llmProtocol/providers/providers';
import { IPlatformService } from '#/app/platform/platform';
import type { ProviderConfig } from '#/app/provider/provider';
import { IProviderService } from '#/app/provider/provider';
import { IProtocolAdapterRegistry, type Protocol, type ProtocolProviderOptions } from '#/app/protocol/protocol';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

import { IHostRequestHeaders } from './hostRequestHeaders';
import type { ModelConfig } from './model';
import { IModelService } from './model';
import {
  deriveProviderId,
  effectiveModelConfig,
  nonEmpty,
  resolveModelAuthMaterial,
  type ResolvedModelAuthMaterial,
} from './modelAuth';
import type { AuthProvider, Model } from './modelInstance';
import { IModelResolver } from './modelResolver';
import { ModelImpl, StaticAuthProvider } from './modelImpl';
import { resolveThinkingEffortForModel } from './thinking';

interface ThinkingSection {
  readonly enabled?: boolean;
  readonly effort?: string;
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
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
  ) {
    super();
  }

  resolve(id: string): Model {
    const configuredModel = this.models.get(id);
    if (configuredModel === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }
    const model = effectiveModelConfig(configuredModel);

    const { providerConfig, providerName, resolvedBaseUrl: rawBaseUrl } = this.resolveProviderContext(id, model);
    const auth = resolveModelAuthMaterial({
      modelId: id,
      model,
      provider: providerConfig,
      providerName,
      getPlatform: (platformId) => this.platforms.get(platformId),
    });
    const authProvider = this.buildAuthProvider(providerName, auth);

    const protocol = this.resolveProtocol(id, model, providerConfig);
    const resolvedBaseUrl =
      model.protocol === 'anthropic' && rawBaseUrl !== undefined
        ? stripTrailingV1(rawBaseUrl)
        : rawBaseUrl;
    const wireName = model.name ?? model.model;
    if (wireName === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must define a wire-facing name in config.toml.`,
      );
    }
    if (model.maxContextSize === undefined) {
      throw new Error2(
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
      alwaysThinking,
      providerName,
      authProvider,
      protocolRegistry: this.protocolRegistry as ProtocolAdapterRegistry,
      providerOptions,
    });

    const effort = this.resolveDefaultThinking(model, alwaysThinking);
    return effort === 'off' ? impl : impl.withThinking(effort);
  }

  private resolveDefaultThinking(
    model: ModelConfig,
    alwaysThinking: boolean,
  ): ThinkingEffort {
    const thinking = this.config.get<ThinkingSection | undefined>('thinking');
    return resolveThinkingEffortForModel(
      undefined,
      {
        enabled: thinking?.enabled,
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

  private resolveProviderContext(
    id: string,
    model: ModelConfig,
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
          ErrorCodes.CONFIG_INVALID,
          `Provider "${providerId}" referenced by model "${id}" is not configured.`,
        );
      }
      const baseUrl =
        nonEmpty(model.baseUrl) ??
        nonEmpty(providerConfig.baseUrl) ??
        providerBaseUrlEnvFallback(
          model.protocol ?? providerConfig.type,
          providerConfig.env,
        );
      return { providerConfig, providerName: providerId, resolvedBaseUrl: baseUrl };
    }

    const modelBaseUrl = nonEmpty(model.baseUrl);
    if (modelBaseUrl === undefined) {
      throw new Error2(
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
    const explicit = model.protocol ?? provider?.type;
    if (explicit === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must declare a wire protocol (config: models.<id>.protocol).`,
      );
    }
    return explicit;
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
          ErrorCodes.AUTH_LOGIN_REQUIRED,
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
  const hostLayer = providerType === 'kimi' ? hostHeaders : userAgentOnly(hostHeaders);
  return { ...parseKimiCodeCustomHeaders(), ...hostLayer, ...customHeaders };
}

function userAgentOnly(headers: Readonly<Record<string, string>>): Record<string, string> {
  const userAgent = headers['User-Agent'];
  return userAgent === undefined ? {} : { 'User-Agent': userAgent };
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

function stripTrailingV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

function buildProtocolProviderOptions(
  model: ModelConfig,
  protocol: Protocol,
  provider: ProviderConfig | undefined,
  baseUrl: string | undefined,
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
  IModelResolver,
  ModelResolverService,
  InstantiationType.Delayed,
  'modelResolver',
);
