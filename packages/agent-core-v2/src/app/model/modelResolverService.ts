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
import { IOAuthService } from '#/app/auth';
import { IConfigService } from '#/app/config';
import { ErrorCodes, KimiError } from '#/errors';
import {
  UNKNOWN_CAPABILITY,
  type ModelCapability,
  type ProviderRequestAuth,
} from '#/app/llmProtocol';
import { IPlatformService, UNKNOWN_PLATFORM_KEY } from '#/app/platform';
import type { OAuthRef, ProviderConfig } from '#/app/provider';
import { IProviderService } from '#/app/provider';
import { IProtocolAdapterRegistry, type Protocol } from '#/app/protocol';
import { type ProtocolAdapterRegistry } from '#/app/protocol/protocolAdapterRegistry';

import type { ModelConfig } from './model';
import { IModelService } from './model';
import type { AuthProvider, Model } from './modelInstance';
import { IModelResolver } from './modelResolver';
import { ModelImpl, StaticAuthProvider } from './modelImpl';

interface ResolvedAuthMaterial {
  readonly apiKey?: string;
  readonly oauth?: OAuthRef;
  readonly oauthProviderKey?: string;
}

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
    const model = this.models.get(id);
    if (model === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" is not configured in config.toml.`,
      );
    }

    const { providerConfig, providerName, resolvedBaseUrl } = this.resolveProviderContext(id, model);
    const auth = this.resolveAuth(model, providerConfig);
    const authProvider = this.buildAuthProvider(providerName, auth);

    const protocol = this.resolveProtocol(id, model, providerConfig);
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

    const declared = new Set((model.capabilities ?? []).map((c) => c.trim().toLowerCase()));
    const capabilities: ModelCapability = {
      ...UNKNOWN_CAPABILITY,
      max_context_tokens: model.maxContextSize,
      image_in: declared.has('image_in') || UNKNOWN_CAPABILITY.image_in,
      video_in: declared.has('video_in') || UNKNOWN_CAPABILITY.video_in,
      tool_use: declared.has('tool_use') || UNKNOWN_CAPABILITY.tool_use,
    };
    const alwaysThinking = declared.has('always_thinking');

    return new ModelImpl({
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
      alwaysThinking,
      providerName,
      authProvider,
      protocolRegistry: this.protocolRegistry as ProtocolAdapterRegistry,
    });
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
      const baseUrl = model.baseUrl ?? providerConfig.baseUrl;
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
    if (model.baseUrl === undefined || model.baseUrl.length === 0) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${id}" must set either providerId or baseUrl in config.toml.`,
      );
    }
    const originName = deriveProviderId(model.baseUrl);
    return {
      providerConfig: undefined,
      providerName: originName,
      resolvedBaseUrl: model.baseUrl,
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
   */
  private resolveAuth(
    model: ModelConfig,
    provider: ProviderConfig | undefined,
  ): ResolvedAuthMaterial {
    if (model.apiKey !== undefined) return { apiKey: model.apiKey };
    if (model.oauth !== undefined) {
      return { oauth: model.oauth, oauthProviderKey: model.providerId ?? model.provider };
    }

    const platformId = provider?.platformId;
    if (platformId !== undefined && platformId !== UNKNOWN_PLATFORM_KEY) {
      const platform = this.platforms.get(platformId);
      if (platform?.auth?.apiKey !== undefined) return { apiKey: platform.auth.apiKey };
      if (platform?.auth?.oauth !== undefined) {
        return {
          oauth: platform.auth.oauth,
          oauthProviderKey: platformId,
        };
      }
    }

    // Legacy: provider carried auth directly (pre-Phase 4 migration).
    if (provider?.apiKey !== undefined) return { apiKey: provider.apiKey };
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
      return {
        async getAuth(options): Promise<ProviderRequestAuth | undefined> {
          const tokenProvider = oauthService.resolveTokenProvider(providerKey, oauthRef);
          if (tokenProvider === undefined) return undefined;
          const apiKey = await tokenProvider.getAccessToken({ force: options?.force ?? false });
          if (apiKey.trim().length === 0) return undefined;
          return { apiKey };
        },
      };
    }
    return new StaticAuthProvider(undefined);
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
