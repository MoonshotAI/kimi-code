/**
 * `kosongConfig` domain (L3) — `IModelsDevImportService`: import providers
 * from the third-party models.dev directory and models.dev-shaped private
 * registries.
 *
 * Browses the models.dev directory (proxied through `modelsDevUpstream`'s
 * fetch/cache/snapshot layer), imports a directory entry as a configured
 * provider, and imports a private registry (api.json, the same document
 * shape as models.dev) — the registration capability the TUI/CLI get
 * through the node-sdk, owned here so edge servers (kap-server) never touch
 * the underlying directory/registry packages directly. Like
 * `IProviderDiscoveryService` this is a WRITE path (external world → config
 * → kosong registries via the persistence bridge); the global
 * default_provider/default_model pointers are never modified by an import —
 * except that a default_model is seeded from the first imported model when
 * none is configured at all (fresh setup).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ProviderCatalogItem } from '#/kosong/model/catalog';

// ---------------------------------------------------------------------------
// Browse wire shapes (pruned models.dev directory items)
// ---------------------------------------------------------------------------

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
  /** True when the wire came from the OpenAI-compatible fallback, not a declaration. */
  readonly guessed: boolean;
  /** True when the import form must collect a base URL from the user. */
  readonly needs_base_url: boolean;
  /** True when the entry cannot be imported at all (greyed out by clients). */
  readonly rejected: boolean;
  readonly reject_reason: string | null;
  /** The credential env var the vendor conventionally uses, as a hint. */
  readonly env_key: string | null;
  readonly models: readonly ModelsDevModelItem[];
}

// ---------------------------------------------------------------------------
// Import options / results
// ---------------------------------------------------------------------------

/**
 * The provider id shape accepted by the import routes (and by the manual
 * create/replace forms on the edge): starts with a letter or digit, then
 * letters, digits, `-`, `_` and spaces.
 */
export const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

export interface ImportModelsDevProviderOptions {
  /** The models.dev directory id to import. */
  readonly catalogId: string;
  /** Overrides the directory id as the local provider id. */
  readonly id?: string;
  /**
   * Tri-state credential: absent keeps the stored key on a re-import, `""`
   * clears it, anything else replaces it.
   */
  readonly apiKey?: string;
  /** Required when the entry resolves to needs-base-url; overrides the directory endpoint. */
  readonly baseUrl?: string;
}

export interface ImportModelsDevProviderResult {
  readonly provider: ProviderCatalogItem;
  readonly modelsImported: number;
}

export interface ImportCustomRegistryOptions {
  /** api.json URL — the stable registry identity across re-imports. */
  readonly url: string;
  /**
   * Tri-state Bearer key: absent inherits the key from the previous import
   * of the same URL, `""` clears it, anything else replaces it.
   */
  readonly apiKey?: string;
}

export interface ImportCustomRegistryResult {
  readonly providers: readonly ProviderCatalogItem[];
  readonly modelsImported: number;
}

export interface IModelsDevImportService {
  readonly _serviceBrand: undefined;

  /** The pruned models.dev directory, in upstream order. */
  listModelsDevProviders(): Promise<ModelsDevProviderItem[]>;
  /** One directory entry; throws `modelsDev.catalog_entry_not_found`. */
  getModelsDevProvider(catalogId: string): Promise<ModelsDevProviderItem>;
  /**
   * Import a models.dev directory entry as a configured provider. Importing
   * an id that already exists is a refresh: the provider entry and its
   * aliases are rewritten from the directory (OAuth-managed providers are
   * rejected instead).
   */
  importModelsDevProvider(
    options: ImportModelsDevProviderOptions,
  ): Promise<ImportModelsDevProviderResult>;
  /**
   * Import a models.dev-shaped private registry (api.json URL + optional
   * Bearer key). Every listed provider is written with a `source` blob so
   * scheduled refreshes rediscover it; re-importing the same URL removes
   * providers that disappeared upstream.
   */
  importCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult>;
}

export const IModelsDevImportService: ServiceIdentifier<IModelsDevImportService> =
  createDecorator<IModelsDevImportService>('modelsDevImport');
