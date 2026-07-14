/**
 * `modelCatalog` domain (L3) — read-only catalog over configured providers and
 * model aliases, plus the global default-model selection.
 *
 * Projects the `provider` / `model` configuration registries into the
 * protocol `ProviderCatalogItem` / `ModelCatalogItem` wire shapes that the
 * edge (`server-v2` `/api/v1` routes) serves. App-scoped — provider and
 * model configuration is global and shared across sessions. This domain is a
 * thin facade over `provider`, `model`, `config`, and `auth`; it owns no
 * persistence of its own. The OAuth-provider model refresh lives in
 * The OAuth-provider model refresh lives in `auth` (`IOAuthService`), not here.
 */

import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  RefreshProviderModelsResponse,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ModelAlias } from '#/app/model/model';
import type { ProviderConfig } from '#/app/provider/provider';

export type RefreshProviderModelsScope = 'all' | 'oauth';

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  readonly providerId?: string;
}

export interface IModelCatalogService {
  readonly _serviceBrand: undefined;

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

export const IModelCatalogService: ServiceIdentifier<IModelCatalogService> =
  createDecorator<IModelCatalogService>('modelCatalogService');

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
}

export function toProtocolModel(modelId: string, alias: ModelAlias): ModelCatalogItem {
  return {
    provider: alias.provider ?? '',
    model: modelId,
    display_name: alias.displayName ?? alias.model ?? modelId,
    max_context_size: alias.maxContextSize ?? 0,
    capabilities: alias.capabilities,
  };
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  models: Readonly<Record<string, ModelAlias>>,
  globalDefaultModel: string | undefined,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const providerModels = modelIdsForProvider(models, providerId);
  const defaultModel =
    provider.defaultModel ?? globalDefaultForProvider(models, globalDefaultModel, providerId);
  return {
    id: providerId,
    type: provider.type ?? 'openai',
    base_url: provider.baseUrl,
    default_model: defaultModel,
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    models: providerModels,
  };
}

export function modelIdsForProvider(
  models: Readonly<Record<string, ModelAlias>>,
  providerId: string,
): string[] {
  return Object.entries(models)
    .filter(([, alias]) => alias.provider === providerId)
    .map(([modelId]) => modelId);
}

function globalDefaultForProvider(
  models: Readonly<Record<string, ModelAlias>>,
  globalDefaultModel: string | undefined,
  providerId: string,
): string | undefined {
  if (globalDefaultModel === undefined) return undefined;
  const alias = models[globalDefaultModel];
  return alias?.provider === providerId ? globalDefaultModel : undefined;
}
