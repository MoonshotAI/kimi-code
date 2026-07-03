import { createDecorator } from '../../di';
import { effectiveModelAlias, type KimiConfig, type ModelAlias, type ProviderConfig } from '../../config';
import type {
  ModelCatalogItem,
  ProviderCatalogItem,
  RefreshOAuthProviderModelsResponse,
  RefreshProviderModelsResponse,
  SetDefaultModelResponse,
} from '@moonshot-ai/protocol';

export type RefreshProviderModelsScope = 'all' | 'oauth';

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  /** Refresh only this provider id. When set, `scope` is ignored. */
  readonly providerId?: string;
}

export interface IModelCatalogService {
  readonly _serviceBrand: undefined;

  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IModelCatalogService = createDecorator<IModelCatalogService>(
  'modelCatalogService',
);

export class ProviderNotFoundError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`provider ${providerId} does not exist`);
    this.name = 'ProviderNotFoundError';
    this.providerId = providerId;
  }
}

export class ModelNotFoundError extends Error {
  readonly modelId: string;

  constructor(modelId: string) {
    super(`model ${modelId} does not exist`);
    this.name = 'ModelNotFoundError';
    this.modelId = modelId;
  }
}

export function toProtocolModel(
  modelId: string,
  alias: ModelAlias,
): ModelCatalogItem {
  const effective = effectiveModelAlias(alias);
  return {
    provider: effective.provider,
    model: modelId,
    display_name: effective.displayName ?? effective.model,
    max_context_size: effective.maxContextSize,
    capabilities: effective.capabilities,
    support_efforts: effective.supportEfforts,
    default_effort: effective.defaultEffort,
  };
}

export interface ProviderCredentialState {
  readonly hasApiKey: boolean;
  readonly hasOAuthToken: boolean;
}

export function toProtocolProvider(
  providerId: string,
  provider: ProviderConfig,
  config: KimiConfig,
  credential: ProviderCredentialState,
): ProviderCatalogItem {
  const models = modelIdsForProvider(config, providerId);
  const defaultModel = provider.defaultModel ?? globalDefaultForProvider(config, providerId);
  return {
    id: providerId,
    type: provider.type,
    base_url: provider.baseUrl,
    default_model: defaultModel,
    has_api_key: credential.hasApiKey,
    status: credential.hasApiKey || credential.hasOAuthToken ? 'connected' : 'unconfigured',
    models,
  };
}

export function modelIdsForProvider(
  config: KimiConfig,
  providerId: string,
): string[] {
  const models = config.models ?? {};
  return Object.entries(models)
    .filter(([, alias]) => alias.provider === providerId)
    .map(([modelId]) => modelId);
}

function globalDefaultForProvider(
  config: KimiConfig,
  providerId: string,
): string | undefined {
  const defaultModel = config.defaultModel;
  if (defaultModel === undefined) return undefined;
  const alias = config.models?.[defaultModel];
  return alias?.provider === providerId ? defaultModel : undefined;
}

void IModelCatalogService;
