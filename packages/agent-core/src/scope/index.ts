/**
 * Barrel for the di-v3 scope mechanism.
 *
 * Re-exports the public scope surface so consumers can reach it from a single
 * entry point (`#/scope`) and, transitively, from the top-level
 * `@moonshot-ai/agent-core` barrel.
 *
 * The surface is intentionally explicit (not `export *`) so internal helpers
 * (`ScopeRegistry`, `scopeRegistry`, `_resetScopeRegistryForTests`,
 * `ScopeHandle`, `ScopeIdentityContext`, `ScopedServiceEntry`) stay private to
 * the mechanism and do not leak onto the package's public API.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md`.
 */

// Lifecycle scope enum (Core → Session → Agent → Turn → ToolCall).
export { LifecycleScope } from './lifecycle';

// Pattern-1 scoped service registry entry points.
export {
  getScopedServiceDescriptors,
  isBuilt,
  markBuilt,
  registerScopedService,
} from './registry';

// Scope handle + the read-only accessor it exposes.
export type { IScopeHandle, IServiceAccessor } from './handle';

// Generic + per-scope builders.
export {
  AgentScopeBuilder,
  ScopeBuilder,
  SessionScopeBuilder,
  TurnScopeBuilder,
} from './builder';

// Manager pattern base + contracts.
export { ScopeManager } from './manager';
export type {
  IChildLifecycleEvent,
  IManagerEventBus,
  IManagerService,
} from './manager';

// Scope identity contexts (declaration-merged interface + decorator value).
export {
  IAgentContext,
  ISessionContext,
  IToolCallContext,
  ITurnContext,
} from './context';
