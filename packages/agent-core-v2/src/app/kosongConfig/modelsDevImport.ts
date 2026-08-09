/**
 * `kosongConfig` domain — `IModelsDevImportService`: import providers
 * from the third-party models.dev directory and models.dev-shaped private
 * registries.
 *
 * Browses the models.dev directory, imports a directory entry as a
 * configured provider, and imports a private registry (api.json, the same
 * document shape as models.dev) — owned here so edge servers never touch the
 * underlying directory/registry packages directly. This is a WRITE path
 * (external world → config → kosong registries via the persistence bridge);
 * the global default_provider/default_model pointers are never modified by
 * an import — except that a default_model is seeded from the first imported
 * model when none is configured at all (fresh setup).
 */

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
