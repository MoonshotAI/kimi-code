/**
 * `externalHooks` domain barrel — re-exports the Session-scope external hooks
 * contract and its scoped service. Importing this barrel registers the
 * `ISessionExternalHooksService` binding into the scope registry.
 */

export * from './externalHooks';
export * from './externalHooksService';
