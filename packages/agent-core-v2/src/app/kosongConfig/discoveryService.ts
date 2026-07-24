/**
 * `kosongConfig` domain (L3) — `IProviderDiscoveryService` implementation.
 *
 * Owns the all-provider model refresh: delegates to the shared
 * `@moonshot-ai/kimi-code-oauth` orchestrator (managed OAuth + open
 * platforms + custom registries), applies the discovered providers/models
 * to kosong's in-memory registries (the persistence bridge writes them back
 * to config), and publishes `event.model_catalog.changed` on change. Bound
 * at App scope.
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
 * Two write-path details preserve the legacy semantics exactly:
 *  - Registry replaces preserve the entries the orchestrator could not see:
 *    the static exclusion AND the config-file-external entries (the
 *    env-synthesized `__kimi_env__` slice), which the orchestrator's
 *    user-value view does not contain.
 *  - `defaultModel` / `thinking` stay direct `config.replace` writes (like
 *    the OAuth flows): the env overlay may pin the runtime default to the
 *    env-synthesized model, and only the config effective view knows that —
 *    the bridge then syncs the effective pointer into the registry.
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
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
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
  IProviderDiscoveryService,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
} from './discovery';

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

  /**
   * The registry entries the orchestrator's user-value view cannot see (the
   * env-synthesized slice): preserved verbatim across every registry
   * replace, or a refresh would drop the runtime env model/provider.
   */
  private syntheticProviders(
    userProviders: Readonly<Record<string, unknown>>,
  ): Record<string, ProviderConfig> {
    return withoutKeys(this.providerService.list(), userProviders);
  }

  private syntheticModels(
    userModels: Readonly<Record<string, unknown>>,
  ): Record<string, ModelRecord> {
    return withoutKeys(this.modelService.list(), userModels);
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
    await this.providerService.replaceAll({
      ...this.syntheticProviders(providers),
      ...restProviders,
    });
    await this.modelService.replaceAll({ ...this.syntheticModels(models), ...restModels });
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
    const userProviders =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const userModels =
      this.config.inspect<Record<string, ModelRecord>>(MODELS_SECTION).userValue ?? {};
    if (patch.providers !== undefined) {
      await this.providerService.replaceAll({
        ...this.syntheticProviders(userProviders),
        ...exclusion.providers,
        ...patch.providers,
      });
    }
    if (patch.models !== undefined) {
      await this.modelService.replaceAll({
        ...this.syntheticModels(userModels),
        ...exclusion.models,
        // The orchestrator's alias shape is a structural superset of
        // ModelRecord at runtime (its protocol union additionally allows
        // vendor spellings the records never actually carry); the legacy
        // config.write path took `unknown`, so cast here.
        ...(patch.models as Record<string, ModelRecord>),
      });
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
    //
    // `defaultModel` / `thinking` go through config directly (not the
    // registry): the env overlay may pin the runtime default, and only the
    // config effective view knows — the bridge syncs the effective pointer
    // into the registry afterwards.
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
    // The writes above landed in the registries / config; compute the
    // post-patch shape in memory (re-reading config would race the bridge's
    // asynchronous persist of the registry changes).
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
  'kosongConfig',
);
