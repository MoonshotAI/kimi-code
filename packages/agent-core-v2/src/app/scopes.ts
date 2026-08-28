import { setScopeTopology } from '#/_base/di/scope';

export enum LifecycleScope {
  App = 'app',
  Session = 'session',
}

export const SCOPE_TOPOLOGY: readonly LifecycleScope[] = [
  LifecycleScope.App,
  LifecycleScope.Session,
];

setScopeTopology(SCOPE_TOPOLOGY);
