/**
 * `agentProfileCatalog` domain barrel — re-exports the catalog contract, its
 * scoped service, and the module-level `registerAgentProfile(...)` entry point.
 * Importing this barrel registers the `IAgentProfileCatalogService` binding
 * into the App scope registry. Builtin profiles are contributed by their owning
 * domains (`agentLifecycle`, `plan`).
 */

export * from './agentProfileCatalog';
export * from './agentProfileCatalogService';
export * from './promptPrefix';
export {
  registerAgentProfile,
  getAgentProfileContributions,
  _clearAgentProfileContributionsForTests,
} from './contribution';
