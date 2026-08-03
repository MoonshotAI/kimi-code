/**
 * `externalHooks` domain barrel — re-exports the Session-scope external hooks
 * contract (`externalHooks`) and its scoped service (`externalHooksService`).
 * Importing this barrel registers the `ISessionExternalHooksService` binding
 * into the scope registry.
 */

export * from './externalHooks';
export * from './externalHooksService';
