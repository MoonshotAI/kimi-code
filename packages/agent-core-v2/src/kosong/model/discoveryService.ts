/**
 * `kosong/model` domain (L2) — `IProviderDiscoveryService` implementation.
 *
 * Owns the all-provider model refresh: delegates to the shared
 * `@moonshot-ai/kimi-code-oauth` orchestrator (managed OAuth + open
 * platforms + custom registries), writes the discovered providers/models
 * back through `config`, and publishes `event.model_catalog.changed` on
 * change. Bound at App scope.
 *
 * `modelSource: 'static'` short-circuits refresh: a provider whose effective
 * model source is `static` (config-declared, or declared by its vendor
 * definition) serves its models from the static `[models.*]` section, so
 * discovery must not touch it. A statically-sourced target of a scoped
 * refresh answers `unchanged` without any network I/O; for an unscoped
 * refresh the static entries are hidden from the orchestrator's config view
 * and merged back verbatim on every write, so the orchestrator can neither
 * refresh them nor drop them (or a default model pointing at them).
 *
 * Credential detection goes through the provider-definition registry
 * (`resolveProviderEndpoint` against the provider's config env bag), not a
 * per-protocol env table.
 */

import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';

import { IConfigService } from '../../app/config/config';
import { ModelCatalogErrors } from './errors';
import { IHostRequestHeaders } from './hostRequestHeaders';
import {
  DEFAULT_MODEL_SECTION,
  IModelService,
  MODELS_SECTION,
  type ModelRecord,
} from './model';
import { THINKING_SECTION } from './thinking';

import {
  IProviderDiscoveryService,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
} from './discovery';
import {
  IProviderService,
  type ModelSource,
  type OAuthRef,
  type ProviderConfig,
  PROVIDERS_SECTION,
} from '../provider/provider';
import { getProviderDefinition } from '../provider/providerDefinition';

/**
 * Statically-sourced providers (and their bound models) hidden from the
 * refresh orchestrator, plus the user's default selection when it points at
 * an excluded model.
 */
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
    @IModelService private readonly modelService: IModelService,
    @IProviderService private readonly providerService: IProviderService,
    @IConfigService private readonly config: IConfigService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IEventService private readonly events: IEventService,
    @IHostRequestHeaders private readonly hostRequestHeaders: IHostRequestHeaders,
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
      // Static short-circuit: the provider's models come from the static
      // `[models.*]` section — discovery is a no-op by declaration.
      if (this.effectiveModelSource(provider) === 'static') {
        return { changed: [], unchanged: [options.providerId], failed: [] };
      }
    }

    const exclusion = this.computeStaticExclusion();
    const result = await refreshProviderModels(this.buildRefreshHost(exclusion), {
      scope: options.scope,
      providerId: options.providerId,
    });
    const response = mapRefreshResult(result);
    if (response.changed.length > 0) {
      this.events.publish({ type: 'event.model_catalog.changed', payload: response });
    }
    return response;
  }

  private effectiveModelSource(provider: ProviderConfig): ModelSource | undefined {
    return (
      provider.modelSource ??
      (provider.type === undefined ? undefined : getProviderDefinition(provider.type)?.modelSource)
    );
  }

  /**
   * The statically-sourced slice of the user config: hidden from the
   * orchestrator so it can neither refresh nor rewrite those entries, and
   * merged back verbatim on every write.
   */
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

  private buildRefreshHost(exclusion: StaticExclusion): RefreshProviderHost {
    return {
      getConfig: async () => this.readUserConfigShape(exclusion),
      removeProvider: (providerId) => this.removeProviderForRefresh(providerId),
      setConfig: (patch) => this.applyRefreshPatch(patch, exclusion),
      resolveOAuthToken: (providerName, oauthRef) => this.resolveOAuthToken(providerName, oauthRef),
      userAgent: this.hostRequestHeaders.headers['User-Agent'],
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

  private async removeProviderForRefresh(providerId: string): Promise<ManagedKimiConfigShape> {
    const current = this.readUserConfigShape();
    const providers = current.providers as Record<string, ProviderConfig>;
    const restProviders = Object.fromEntries(
      Object.entries(providers).filter(([id]) => id !== providerId),
    );
    const models = (current.models ?? {}) as Record<string, ModelRecord>;
    const restModels = Object.fromEntries(
      Object.entries(models).filter(([, record]) => record.provider !== providerId),
    );
    await this.config.replace(PROVIDERS_SECTION, restProviders);
    await this.config.replace(MODELS_SECTION, restModels);
    return {
      ...current,
      providers: restProviders,
      models: restModels,
    } as ManagedKimiConfigShape;
  }

  private async applyRefreshPatch(
    patch: ManagedKimiConfigShape,
    exclusion: StaticExclusion,
  ): Promise<ManagedKimiConfigShape> {
    if (patch.providers !== undefined) {
      await this.config.replace(PROVIDERS_SECTION, {
        ...exclusion.providers,
        ...patch.providers,
      });
    }
    if (patch.models !== undefined) {
      await this.config.replace(MODELS_SECTION, { ...exclusion.models, ...patch.models });
    }
    // The refresh orchestrator always sends all four keys, so key presence is
    // the write intent and an explicit `undefined` means CLEAR, not "leave
    // alone". `set()` cannot express that — its deepMerge resolves an
    // undefined patch back to the base value — so these go through `replace`,
    // which deletes the section on undefined. Otherwise a default model (and
    // its thinking setting) whose alias the upstream dropped would dangle in
    // the user config forever.
    //
    // Exception: when the user's default points at a statically-sourced model
    // the orchestrator could not see, its clamp/restore logic would silently
    // clear or re-point the selection (and its thinking) — restore both.
    const restoreDefault = exclusion.defaultModel !== undefined;
    if ('defaultModel' in patch) {
      await this.config.replace(
        DEFAULT_MODEL_SECTION,
        restoreDefault ? exclusion.defaultModel : patch.defaultModel,
      );
    }
    if ('thinking' in patch) {
      await this.config.replace(
        THINKING_SECTION,
        restoreDefault ? exclusion.thinking : patch.thinking,
      );
    }
    return this.readUserConfigShape();
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
      throw new Error('OAuth token provider is not configured.');
    }
    return tokenProvider.getAccessToken();
  }
}

/** The record with the excluded record's keys removed. */
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
  InstantiationType.Eager,
  'modelCatalog',
);
