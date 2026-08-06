/**
 * `app` domain — the business scope tier set and its topology declaration.
 *
 * The DI kernel (`_base/di/scope`) only knows the scope tree and opaque
 * `ScopeKind` strings; the four tiers and their parent → child order are a
 * business concept, declared here as a module side effect so importing the
 * package (or this module) installs the topology.
 */

import { setScopeTopology } from '#/_base/di/scope';

export enum LifecycleScope {
  App = 'app',
  Workspace = 'workspace',
  Session = 'session',
  Agent = 'agent',
}

export const SCOPE_TOPOLOGY: readonly LifecycleScope[] = [
  LifecycleScope.App,
  LifecycleScope.Workspace,
  LifecycleScope.Session,
  LifecycleScope.Agent,
];

setScopeTopology(SCOPE_TOPOLOGY);
