/**
 * `tool` domain barrel — re-exports the tool contract (`tool`) and its
 * scoped services (`toolService`). Importing this barrel registers the
 * `IToolDefinitionRegistry` and `IToolService` bindings into the scope registry.
 */

export * from './tool';
export * from './toolService';
