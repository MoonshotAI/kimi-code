/**
 * Model-catalog helpers, re-exported through the core facade so TUI files do
 * not import the SDK directly.
 *
 * TODO(migrate): these are still the SDK / agent-core implementations. v2
 * covers part of this surface via `IModelCatalogService` / `IModelService`
 * (reached through `CoreHarness`); the remaining pure helpers should move to a
 * shared home. Until then the TUI consumes them from `#/core/index` only.
 */
export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  effectiveModelAlias,
  fetchCatalog,
  inferWireType,
  type Catalog,
  type CatalogModel,
} from '@moonshot-ai/kimi-code-sdk';
