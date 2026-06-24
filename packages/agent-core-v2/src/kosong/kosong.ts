/**
 * `kosong` domain (L1) — LLM / provider abstractions across three scopes.
 *
 * NOTE: kosong (L1) reads its config section from `IConfigService` (L2) — a
 * documented layering exception (see `plan/skeleton-spec.md` rule 9).
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
