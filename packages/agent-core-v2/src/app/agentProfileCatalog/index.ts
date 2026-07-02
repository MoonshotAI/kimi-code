/**
 * `agentProfileCatalog` domain barrel — re-exports the catalog contract, its
 * scoped service, and the module-level `registerAgentProfile(...)` entry point.
 * Importing this barrel registers the `IAgentProfileCatalogService` binding
 * into the App scope registry and side-effect-loads the builtin profiles
 * (`coder`, `explore`) into the module-level contribution list.
 */

export * from './agentProfileCatalog';
export * from './agentProfileCatalogService';
export {
  registerAgentProfile,
  getAgentProfileContributions,
  _clearAgentProfileContributionsForTests,
} from './contribution';
import './builtin';
