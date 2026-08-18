import { setScopeTopology } from '#/_base/di/scope';

export enum LifecycleScope {
  App = 'app',
  Session = 'session',
  Agent = 'agent',
}

export const SCOPE_TOPOLOGY: readonly LifecycleScope[] = [
  LifecycleScope.App,
  LifecycleScope.Session,
  LifecycleScope.Agent,
];

setScopeTopology(SCOPE_TOPOLOGY);
