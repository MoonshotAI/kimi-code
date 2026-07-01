/**
 * `flag` domain barrel — re-exports the flag-definition catalog (`registry`),
 * the resolution contract (`flag`), and the scoped service (`flagService`).
 * Importing this barrel registers the `IFlagService` binding into the scope
 * registry.
 */

export * from './registry';
export * from './flag';
export * from './flagService';
