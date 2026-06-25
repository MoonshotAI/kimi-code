/**
 * `tooldedup` domain barrel — re-exports the tool-call deduplication
 * contract (`tooldedup`) and its scoped service (`tooldedupService`). Importing
 * this barrel registers the `IToolDedupService` binding into the scope registry.
 */

export * from './tooldedup';
export * from './tooldedupService';
