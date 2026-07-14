/**
 * `modelCatalog` domain (L3) — `IModelCatalogService` implementation.
 *
 * Projects the `provider` / `model` registries into protocol catalog items,
 * resolves credential state through `config` and `auth`, and persists the
 * global default-model selection through `config`. Also owns the all-provider
 * model refresh (`refreshProviderModels`), which delegates to the shared
 * `@moonshot-ai/kimi-code-oauth` orchestrator (managed OAuth + open platforms
 * + custom registries) and publishes `event.model_catalog.changed` on change.
 * The OAuth-only managed-provider refresh additionally lives in `auth`
 * (`IOAuthService.refreshOAuthProviderModels`). Bound at App scope.
 */

import {
  refreshProviderModels,
  type ManagedKimiConfigShape,
  type ManagedKimiOAuthRef,
  type RefreshProviderHost,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  RefreshProviderModelsResponse,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IConfigService } from '#/app/config/config';
import { ErrorCodes, Error2 } from '#/errors';
import { IEventService } from '#/app/event/event';
import { IModelService, MODELS_SECTION, type ModelAlias } from '#/app/model/model';
import { IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
  PROVIDERS_SECTION,
} from '#/app/provider/provider';

import {
  type ProviderCredentialState,
  type RefreshProviderModelsOptions,
  IModelCatalogService,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog';

const DEFAULT_MODEL_SECTION = 'defaultModel';
const THINKING_SECTION = 'thinking';

export class ModelCatalogService implements IModelCatalogService {
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

  async listModels(): Promise<readonly ModelCatalogItem[]> {
    const models = this.modelService.list();
    return Object.entries(models).map(([modelId, alias]) => toProtocolModel(modelId, alias));
  }

  async listProviders(): Promise<readonly ProviderCatalogItem[]> {
    const providers = this.providerService.list();
    const models = this.modelService.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    const out: ProviderCatalogItem[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      out.push(await this.toCatalogProvider(providerId, provider, models, globalDefaultModel));
    }
    return out;
  }

  async getProvider(providerId: string): Promise<ProviderCatalogItem> {
    const provider = this.providerService.get(providerId);
    if (provider === undefined) {
      throw new Error2(ErrorCodes.PROVIDER_NOT_FOUND, `provider ${providerId} does not exist`);
    }
    const models = this.modelService.list();
    const globalDefaultModel = this.config.get<string>(DEFAULT_MODEL_SECTION);
    return this.toCatalogProvider(providerId, provider, models, globalDefaultModel);
  }

  async setDefaultModel(modelId: string): Promise<SetDefaultModelResponse> {
    const alias = this.modelService.get(modelId);
    if (alias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_FOUND, `model ${modelId} does not exist`);
    }
    await this.config.set(DEFAULT_MODEL_SECTION, modelId);
    const updatedAlias = this.modelService.get(modelId) ?? alias;
    return {
      default_model: modelId,
      model: toProtocolModel(modelId, updatedAlias),
    };
  }

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
          ErrorCodes.PROVIDER_NOT_FOUND,
          `provider ${options.providerId} does not exist`,
        );
      }
    }

    const result = await refreshProviderModels(this.buildRefreshHost(), {
      scope: options.scope,
      providerId: options.providerId,
    });
    const response = mapRefreshResult(result);
    if (response.changed.length > 0) {
      this.events.publish({ type: 'event.model_catalog.changed', payload: response });
    }
    return response;
  }

  private buildRefreshHost(): RefreshProviderHost {
    return {
      getConfig: async () => this.readUserConfigShape(),
      removeProvider: (providerId) => this.removeProviderForRefresh(providerId),
      setConfig: (patch) => this.applyRefreshPatch(patch),
      resolveOAuthToken: (providerName, oauthRef) => this.resolveOAuthToken(providerName, oauthRef),
      userAgent: this.hostRequestHeaders.headers['User-Agent'],
    };
  }

  private readUserConfigShape(): ManagedKimiConfigShape {
    const providers =
      this.config.inspect<Record<string, ProviderConfig>>(PROVIDERS_SECTION).userValue ?? {};
    const models =
      this.config.inspect<Record<string, ModelAlias>>(MODELS_SECTION).userValue ?? {};
    const defaultModel = this.config.inspect<string>(DEFAULT_MODEL_SECTION).userValue;
    const thinking =
      this.config.inspect<ManagedKimiConfigShape['thinking']>(THINKING_SECTION).userValue;
    return {
      providers: { ...providers } as ManagedKimiConfigShape['providers'],
      models: { ...models } as ManagedKimiConfigShape['models'],
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
    const models = (current.models ?? {}) as Record<string, ModelAlias>;
    const restModels = Object.fromEntries(
      Object.entries(models).filter(([, alias]) => alias.provider !== providerId),
    );
    await this.config.replace(PROVIDERS_SECTION, restProviders);
    await this.config.replace(MODELS_SECTION, restModels);
    return {
      ...current,
      providers: restProviders,
      models: restModels,
    } as ManagedKimiConfigShape;
  }

  private async applyRefreshPatch(patch: ManagedKimiConfigShape): Promise<ManagedKimiConfigShape> {
    if (patch.providers !== undefined) {
      await this.config.replace(PROVIDERS_SECTION, patch.providers);
    }
    if (patch.models !== undefined) {
      await this.config.replace(MODELS_SECTION, patch.models);
    }
    if (patch.defaultModel !== undefined) {
      await this.config.set(DEFAULT_MODEL_SECTION, patch.defaultModel);
    }
    if (patch.thinking !== undefined) {
      await this.config.set(THINKING_SECTION, patch.thinking);
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

  private async toCatalogProvider(
    providerId: string,
    provider: ProviderConfig,
    models: Readonly<Record<string, ModelAlias>>,
    globalDefaultModel: string | undefined,
  ): Promise<ProviderCatalogItem> {
    const credential = await this.resolveCredential(providerId, provider);
    return toProtocolProvider(providerId, provider, models, globalDefaultModel, credential);
  }

  private async resolveCredential(
    providerId: string,
    provider: ProviderConfig,
  ): Promise<ProviderCredentialState> {
    return {
      hasApiKey: hasConfiguredApiKey(provider),
      hasOAuthToken: await this.hasCachedToken(providerId, provider),
    };
  }

  private async hasCachedToken(providerId: string, provider: ProviderConfig): Promise<boolean> {
    if (provider.oauth === undefined) return false;
    try {
      const token = await this.oauth.getCachedAccessToken(providerId, provider.oauth);
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }
}

function hasConfiguredApiKey(provider: ProviderConfig): boolean {
  if (nonEmpty(provider.apiKey) !== undefined) return true;
  switch (provider.type) {
    case 'anthropic':
      return nonEmpty(provider.env?.['ANTHROPIC_API_KEY']) !== undefined;
    case 'openai':
    case 'openai_responses':
      return nonEmpty(provider.env?.['OPENAI_API_KEY']) !== undefined;
    case 'kimi':
      return nonEmpty(provider.env?.['KIMI_API_KEY']) !== undefined;
    case 'google-genai':
      return nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined;
    case 'vertexai':
      return (
        nonEmpty(provider.env?.['VERTEXAI_API_KEY']) !== undefined ||
        nonEmpty(provider.env?.['GOOGLE_API_KEY']) !== undefined
      );
  }
  return false;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  IModelCatalogService,
  ModelCatalogService,
  InstantiationType.Delayed,
  'modelCatalog',
);
