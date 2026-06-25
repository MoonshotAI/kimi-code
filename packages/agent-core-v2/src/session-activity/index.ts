/**
 * `session-activity` domain barrel — re-exports the session-activity contract
 * (`sessionActivity`) and its scoped service (`sessionActivityService`).
 * Importing this barrel registers the `ISessionActivity` binding into the scope
 * registry.
 */

export * from './sessionActivity';
export * from './sessionActivityService';
