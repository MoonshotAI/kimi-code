/**
 * `session` domain barrel — re-exports the session facade contract
 * (`session`) and its scoped service (`sessionService`). Importing this
 * barrel registers the `ISessionService` binding into the scope registry.
 */

export * from './session';
export * from './sessionService';
