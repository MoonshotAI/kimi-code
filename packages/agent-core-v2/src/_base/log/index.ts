/**
 * `_base/log` barrel — re-exports the logging contract, plain sinks, and the
 * App-scope `ILogService` binding. Importing this barrel registers the App-scope
 * `ILogService` into the scope registry.
 */

export * from './log';
export * from './logConfig';
export * from './formatter';
export * from './fileLog';
export * from './logService';
