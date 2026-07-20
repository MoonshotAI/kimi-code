/**
 * `modelCatalog` domain (L3) — read-only catalog over configured providers and
 * model aliases, plus the global default-model selection.
 *
 * Projects the `provider` / `model` configuration registries into the
 * `ProviderCatalogItem` / `ModelCatalogItem` wire shapes (defined below as zod
 * schemas) that the edge (`server-v2` `/api/v1` routes) serves. App-scoped — provider and
 * model configuration is global and shared across sessions. This domain is a
 * thin facade over `provider`, `model`, `config`, and `auth`; it owns no
 * persistence of its own. The OAuth-provider model refresh lives in
 * The OAuth-provider model refresh lives in `auth` (`IOAuthService`), not here.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ModelAlias } from '#/app/model/model';
import { effectiveModelConfig } from '#/app/model/modelAuth';
import type { ProviderConfig, ProviderType } from '#/app/provider/provider';

export const modelCatalogItemSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

export const providerRefreshChangeSchema = z.object({
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type ProviderRefreshChange = z.infer<typeof providerRefreshChangeSchema>;

export const providerRefreshFailureSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});
export type ProviderRefreshFailure = z.infer<typeof providerRefreshFailureSchema>;

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshProviderModelsResponse = z.infer<
  typeof refreshProviderModelsResponseSchema
>;

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

export function toProtocolModel(
  modelId: string,
  alias: ModelAlias,
  providerType?: ProviderType,
): ModelCatalogItem {
  const effective = effectiveModelConfig(alias, providerType);
  return {
    provider: effective.provider ?? '',
    model: modelId,
    display_name: effective.displayName ?? effective.model ?? modelId,
    max_context_size: effective.maxContextSize ?? 0,
    capabilities: effective.capabilities,
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
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
