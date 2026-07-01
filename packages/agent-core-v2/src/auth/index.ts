/**
 * `auth` domain barrel — re-exports the auth contract (`auth`) and its scoped
 * services (`authService`). Importing this barrel registers the `IOAuthService`
 * and `IAuthSummaryService` bindings into the scope registry.
 */

export * from './auth';
export * from './authService';
