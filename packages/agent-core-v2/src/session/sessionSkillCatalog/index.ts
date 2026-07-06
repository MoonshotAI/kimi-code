/**
 * `sessionSkillCatalog` domain barrel — re-exports the per-session skill
 * catalog sink contract, its sink service, and the Session-scope workspace /
 * plugin sources. Importing this barrel registers the `ISessionSkillCatalog`
 * sink plus the `IWorkspaceFileSkillSource` and `IPluginSkillSource` bindings
 * into the scope registry.
 */

export * from './skillCatalog';
export * from './skillCatalogService';
export * from './workspaceFileSkillSource';
export * from './pluginSkillSource';
