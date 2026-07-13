/**
 * `externalHooksRunner` domain (L6) barrel — re-exports the App-scope
 * `IExternalHooksRunnerService` contract and its implementation, plus the
 * argument shape shared by callers. Importing this barrel registers the
 * App-scope runner binding into the scope registry.
 */

export * from './externalHooksRunner';
export * from './externalHooksRunnerService';
