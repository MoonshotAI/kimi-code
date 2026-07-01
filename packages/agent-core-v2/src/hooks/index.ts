/**
 * `hooks` domain barrel — re-exports the hook contract (`hooks`) and its scoped
 * service (`hookEngine`). Importing this barrel registers the `IHookEngine`
 * binding into the scope registry.
 */

export * from './hooks';
export * from './hookEngine';
