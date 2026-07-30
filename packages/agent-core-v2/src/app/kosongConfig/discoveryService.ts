/**
 * `kosongConfig` domain (L3) — `IProviderDiscoveryService` implementation.
 *
 * Owns the all-provider model refresh: delegates to the shared
 * `@moonshot-ai/kimi-code-oauth` orchestrator (managed OAuth + open
 * platforms + custom registries), writes the discovered providers/models
 * into config through ONE atomic `replaceSections` transition (the
 * persistence bridge then syncs them into kosong's in-memory registries),
 * and publishes `event.model_catalog.changed` on change. Bound at App
 * scope.
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
 *  - The orchestrator's two-phase host contract (removeProvider, then
 *    setConfig) is absorbed into a single atomic write: the removal is
 *    computed in memory only (`shapeWithoutProvider`), because the patch's
 *    full providers/models records already express it. The runtime
 *    registries therefore never pass through a halfway-removed state — that
 *    intermediate state was the source of the "provider/model not
 *    configured" startup race against profile binding.
 *  - The env-synthesized `__kimi_env__` slice is never written to config:
 *    it lives in the effective overlay, and the bridge's event-driven sync
 *    carries it into the registries on its own. `defaultModel` / `thinking`
 *    also go through config (like the OAuth flows), since the env overlay
 *    may pin the runtime default and only the config effective view knows.
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

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { IHostRequestHeaders } from '#/kosong/model/hostRequestHeaders';
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
      removeProvider: (providerId) => this.shapeWithoutProvider(providerId),
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
   * The orchestrator's host contract is two-phase (removeProvider, then
   * setConfig) because its original merge-semantics host could not delete
   * keys through a patch. This host writes with replace semantics and the
   * patch always carries the FULL providers/models records, so the removal
   * is already expressed by the patch itself — computing it here in memory
   * keeps the runtime registries untouched until the single atomic write in
   * {@link applyRefreshPatch} (a halfway-removed catalog is what used to
   * produce the "provider/model not configured" startup race).
   */
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
    // All four sections land in ONE config transition: a single disk write,
    // then one effective rebuild whose change events synchronously push the
    // new records into the kosong registries — no reader can observe a
    // half-applied refresh. The env-synthesized slice (`__kimi_env__` etc.)
    // is NOT written here: it lives in the effective overlay, and the
    // bridge's event-driven sync carries it into the registries on its own.
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
        // The orchestrator's alias shape is a structural superset of
        // ModelRecord at runtime (its protocol union additionally allows
        // vendor spellings the records never actually carry); the legacy
        // config.write path took `unknown`, so cast here.
        ...(patch.models as Record<string, ModelRecord>),
      };
    }
    // The refresh orchestrator always sends all four keys, so key presence is
    // the write intent and an explicit `undefined` means CLEAR, not "leave
    // alone" — `replaceSections` deletes the section on undefined. Otherwise
    // a default model (and its thinking setting) whose alias the upstream
    // dropped would dangle in the user config forever.
    //
    // Exception: when the user's default points at a statically-sourced model
    // the orchestrator could not see, its clamp/restore logic would silently
    // clear or re-point the selection (and its thinking) — restore both.
    const restoreDefault = exclusion.defaultModel !== undefined;
    if ('defaultModel' in patch) {
      sections[DEFAULT_MODEL_SECTION] = restoreDefault
        ? exclusion.defaultModel
        : patch.defaultModel;
    }
    if ('thinking' in patch) {
      sections[THINKING_SECTION] = restoreDefault ? exclusion.thinking : patch.thinking;
    }
    await this.config.replaceSections(sections);
    // The write above landed in config (and, through the bridge's synchronous
    // event sync, the registries); compute the post-patch shape in memory.
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
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
