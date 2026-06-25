/**
 * `kosong` domain barrel — re-exports the `kosong` contract and its scoped
 * service (`kosongService`). Importing this barrel registers the
 * `IModelCatalogService`, `IProviderManager`, and `ILLMService` bindings into
 * the scope registry.
 */

export * from './kosong';
export * from './kosongService';
