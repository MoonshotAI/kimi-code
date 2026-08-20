import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { type ModelRecord } from '#/kosong/model/model';
import {
  IProviderService,
  type ModelSource,
  type OAuthRef,
  type ProviderConfig,
} from '#/kosong/provider/provider';
import { getProviderDefinition } from '#/kosong/provider/providerDefinition';

import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  THINKING_SECTION,
} from './configSection';
import {
  SECONDARY_MODEL_SECTION,
  cascadeSubagentModelPool,
  type SecondaryModelConfig,
} from '#/session/subagent/configSection';
import {
  IProviderDiscoveryService,
  ModelCatalogChanged,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
} from './discovery';

interface StaticExclusion {
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelRecord>>;
  readonly defaultModel?: string;
  readonly thinking?: ManagedKimiConfigShape['thinking'];
}

const EMPTY_EXCLUSION: StaticExclusion = { providers: {}, models: {} };

export class ProviderDiscoveryService implements IProviderDiscoveryService {
  declare readonly _serviceBrand: undefined;

  private refreshChain: Promise<unknown> = Promise.resolve();

  constructor(
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IEventService private readonly events: IEventService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  refreshProviderModels(
    options: RefreshProviderModelsOptions = {},
  ): Promise<RefreshProviderModelsResponse> {
    const run = this.refreshChain.then(() => this.doRefreshProviderModels(options));
    this.refreshChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRefreshProviderModels(
    options: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse> {
    await this.config.reload();
    if (options.providerId !== undefined) {
      const provider = this.providerService.get(options.providerId);
      if (provider === undefined) {
        throw new Error2(
          ModelCatalogErrors.codes.PROVIDER_NOT_FOUND,
          `provider ${options.providerId} does not exist`,
        );
      }
      if (this.effectiveModelSource(provider) === 'static') {
        return { changed: [], unchanged: [options.providerId], failed: [] };
      }
    }

    const exclusion = this.computeStaticExclusion();
    const { outboundUserAgent } = await this.identity.resolved();
    const result = await refreshProviderModels(this.buildRefreshHost(exclusion, outboundUserAgent), {
      scope: options.scope,
      providerId: options.providerId,
    });
    const response = mapRefreshResult(result);
    if (response.changed.length > 0) {
      this.events.publish(new ModelCatalogChanged({ payload: response }));
    }
    return response;
  }

  private effectiveModelSource(provider: ProviderConfig): ModelSource | undefined {
    return (
      provider.modelSource ??
      (provider.type === undefined ? undefined : getProviderDefinition(provider.type)?.modelSource)
    );
  }

  private computeStaticExclusion(): StaticExclusion {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const staticIds = Object.entries(providers)
      .filter(([, provider]) => this.effectiveModelSource(provider) === 'static')
      .map(([id]) => id);
    if (staticIds.length === 0) return EMPTY_EXCLUSION;

    const excludedProviders: Record<string, ProviderConfig> = {};
    for (const id of staticIds) {
      const provider = providers[id];
      if (provider !== undefined) excludedProviders[id] = provider;
    }
    const models =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const excludedModels: Record<string, ModelRecord> = {};
    for (const [modelId, record] of Object.entries(models)) {
      if (record.provider !== undefined && record.provider in excludedProviders) {
        excludedModels[modelId] = record;
      }
    }
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking = this.config.inspect<ManagedKimiConfigShape['thinking']>(
      THINKING_SECTION,
    ).userValue;
    return {
      providers: excludedProviders,
      models: excludedModels,
      defaultModel:
        defaultModel !== undefined && defaultModel in excludedModels ? defaultModel : undefined,
      thinking:
        defaultModel !== undefined && defaultModel in excludedModels ? thinking : undefined,
    };
  }

  private buildRefreshHost(exclusion: StaticExclusion, userAgent: string): RefreshProviderHost {
    return {
      getConfig: async () => this.readUserConfigShape(exclusion),
      removeProvider: (providerId) => this.shapeWithoutProvider(providerId),
      setConfig: (patch) => this.applyRefreshPatch(patch, exclusion),
      resolveOAuthToken: (providerName, oauthRef) => this.resolveOAuthToken(providerName, oauthRef),
      userAgent,
    };
  }

  private readUserConfigShape(exclusion: StaticExclusion = EMPTY_EXCLUSION): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking =
      this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue;
    return {
      providers: withoutKeys(providers, exclusion.providers) as ManagedKimiConfigShape['providers'],
      models: withoutKeys(models, exclusion.models) as ManagedKimiConfigShape['models'],
      defaultModel,
      thinking: thinking === undefined ? undefined : { ...thinking },
    };
  }

  private shapeWithoutProvider(providerId: string): Promise<ManagedKimiConfigShape> {
    const current = this.readUserConfigShape();
    const providers = current.providers as Record<string, ProviderConfig>;
    const restProviders = Object.fromEntries(
      Object.entries(providers).filter(([id]) => id !== providerId),
    );
    const models = (current.models ?? {}) as Record<string, ModelRecord>;
    const restModels = Object.fromEntries(
      Object.entries(models).filter(([, record]) => record.provider !== providerId),
    );
    return Promise.resolve({
      ...current,
      providers: restProviders,
      models: restModels,
    } as ManagedKimiConfigShape);
  }

  private async applyRefreshPatch(
    patch: ManagedKimiConfigShape,
    exclusion: StaticExclusion,
  ): Promise<ManagedKimiConfigShape> {
    const userProviders =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const userModels =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    const sections: Record<string, unknown> = {};
    if (patch.providers !== undefined) {
      sections[PROVIDERS_SECTION] = {
        ...exclusion.providers,
        ...patch.providers,
      };
    }
    if (patch.models !== undefined) {
      sections[MODELS_SECTION] = {
        ...exclusion.models,
        ...(patch.models as Record<string, ModelRecord>),
      };
    }
    const restoreDefault = exclusion.defaultModel !== undefined;
    if ('defaultModel' in patch) {
      sections[DEFAULT_MODEL_SECTION] = restoreDefault
        ? exclusion.defaultModel
        : patch.defaultModel;
    }
    if ('thinking' in patch) {
      sections[THINKING_SECTION] = restoreDefault ? exclusion.thinking : patch.thinking;
    }
    const nextModels = sections[MODELS_SECTION] as Record<string, ModelRecord> | undefined;
    if (nextModels !== undefined) {
      const cascadedPool = cascadeSubagentModelPool(
        this.config.inspect<SecondaryModelConfig>(SECONDARY_MODEL_SECTION).userValue,
        nextModels,
      );
      if (cascadedPool !== undefined) {
        sections[SECONDARY_MODEL_SECTION] = cascadedPool ?? undefined;
      }
    }
    await this.config.replaceSections(sections);
    return {
      providers:
        patch.providers !== undefined
          ? ({ ...exclusion.providers, ...patch.providers } as ManagedKimiConfigShape['providers'])
          : (userProviders as ManagedKimiConfigShape['providers']),
      models:
        patch.models !== undefined
          ? ({ ...exclusion.models, ...patch.models } as ManagedKimiConfigShape['models'])
          : (userModels as ManagedKimiConfigShape['models']),
      defaultModel:
        'defaultModel' in patch
          ? restoreDefault
            ? exclusion.defaultModel
            : patch.defaultModel
          : this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue,
      thinking:
        'thinking' in patch
          ? restoreDefault
            ? exclusion.thinking
            : patch.thinking
          : this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue,
    };
  }

  private async resolveOAuthToken(
    providerName: string,
    oauthRef?: ManagedKimiOAuthRef,
  ): Promise<string> {
    const tokenProvider = this.oauth.resolveTokenProvider(
      providerName,
      oauthRef as unknown as OAuthRef | undefined,
    );
    if (tokenProvider === undefined) {
      throw new Error2(AuthErrors.codes.AUTH_TOKEN_MISSING, 'OAuth token provider is not configured.', {
        details: { provider_id: providerName },
      });
    }
    return tokenProvider.getAccessToken();
  }
}

function withoutKeys<T>(
  record: Readonly<Record<string, T>>,
  excluded: Readonly<Record<string, unknown>>,
): Record<string, T> {
  if (Object.keys(excluded).length === 0) return { ...record };
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key in excluded)));
}

function mapRefreshResult(result: RefreshResult): RefreshProviderModelsResponse {
  return {
    changed: result.changed.map((change) => ({
      provider_id: change.providerId,
      provider_name: change.providerName,
      added: change.added,
      removed: change.removed,
    })),
    unchanged: [...result.unchanged],
    failed: result.failed.map((failure) => ({
      provider: failure.provider,
      reason: failure.reason,
    })),
  };
}

registerScopedService(
  LifecycleScope.App,
  IProviderDiscoveryService,
  ProviderDiscoveryService,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
