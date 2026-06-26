/**
 * `log` domain barrel — re-exports the `log` contract and its scoped service
 * (`logService`). Importing this barrel registers the `ILogService` and
 * `ILogSink` bindings into the scope registry.
 */

export * from './log';
export * from './logService';
