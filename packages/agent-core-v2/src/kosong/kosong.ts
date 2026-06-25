/**
 * `kosong` domain (L1) — LLM / provider service contracts.
 *
 * Defines the provider and model contracts: `IModelCatalogService` for the
 * provider / model catalog (Core), `IProviderManager` for resolving the active
 * provider and model (Session), and `ILLMService` for generating completions
 * (Agent).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly providerId: string;
}

export interface IModelCatalogService {
  readonly _serviceBrand: undefined;
  listProviders(): Promise<readonly ProviderInfo[]>;
  listModels(providerId?: string): Promise<readonly ModelInfo[]>;
  refresh(): Promise<void>;
}

export const IModelCatalogService: ServiceIdentifier<IModelCatalogService> =
  createDecorator<IModelCatalogService>('modelCatalogService');

export interface ResolvedProvider {
  readonly providerId: string;
  readonly modelId: string;
}

export interface IProviderManager {
  readonly _serviceBrand: undefined;
  resolve(providerId?: string, modelId?: string): Promise<ResolvedProvider>;
}

export const IProviderManager: ServiceIdentifier<IProviderManager> =
  createDecorator<IProviderManager>('providerManager');

export interface GenerateArgs {
  readonly messages: readonly unknown[];
  readonly tools?: readonly unknown[];
}

export interface GenerateResult {
  readonly text: string;
}

export interface ILLMService {
  readonly _serviceBrand: undefined;
  generate(args: GenerateArgs): AsyncIterable<GenerateResult>;
}

export const ILLMService: ServiceIdentifier<ILLMService> =
  createDecorator<ILLMService>('llmService');
