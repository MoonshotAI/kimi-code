import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ProviderCatalogItem } from '#/kosong/model/catalog';

export interface ModelsDevModelItem {
  readonly id: string;
  readonly name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly reasoning: boolean;
}

export interface ModelsDevProviderItem {
  readonly id: string;
  readonly name: string;
  readonly wire_type: string | null;
  readonly guessed: boolean;
  readonly needs_base_url: boolean;
  readonly rejected: boolean;
  readonly reject_reason: string | null;
  readonly env_key: string | null;
  readonly models: readonly ModelsDevModelItem[];
}

export const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

export interface ImportModelsDevProviderOptions {
  readonly catalogId: string;
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ImportModelsDevProviderResult {
  readonly provider: ProviderCatalogItem;
  readonly modelsImported: number;
}

export interface ImportCustomRegistryOptions {
  readonly url: string;
  readonly apiKey?: string;
}

export interface ImportCustomRegistryResult {
  readonly providers: readonly ProviderCatalogItem[];
  readonly modelsImported: number;
}

export interface IModelsDevImportService {
  readonly _serviceBrand: undefined;

  listModelsDevProviders(): Promise<ModelsDevProviderItem[]>;
  getModelsDevProvider(catalogId: string): Promise<ModelsDevProviderItem>;
  importModelsDevProvider(
    options: ImportModelsDevProviderOptions,
  ): Promise<ImportModelsDevProviderResult>;
  importCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult>;
}

export const IModelsDevImportService: ServiceIdentifier<IModelsDevImportService> =
  createDecorator<IModelsDevImportService>('modelsDevImport');
