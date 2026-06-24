export {
  createServices,
  TestInstantiationService,
} from './testInstantiationService';
export type { ServiceIdCtorPair } from './testInstantiationService';

import { type ServiceIdentifier } from './instantiation';
import { createCoreScope, LifecycleScope, Scope, type ScopeSeed } from './scope';

/**
 * Scoped test container.
 *
 * Builds a Scope tree whose layers can be seeded with stub instances
 * (`extra`) so a domain service under test resolves its dependencies as
 * stubs. Mirrors the production `createCoreScope`/`Scope.createChild` shape
 * so domain unit tests exercise the real scope wiring.
 *
 * Usage:
 * ```ts
 * const host = createScopedTestHost();
 * const session = host.child(LifecycleScope.Session, 's1', [[ILog, stubLog]]);
 * const svc = session.accessor.get(IMySessionService);
 * host.dispose();
 * ```
 */
export interface ScopedTestHost {
  readonly core: Scope;
  child(kind: LifecycleScope, id: string, stubs?: ScopeSeed): Scope;
  childOf(parent: Scope, kind: LifecycleScope, id: string, stubs?: ScopeSeed): Scope;
  dispose(): void;
}

export function createScopedTestHost(coreStubs: ScopeSeed = []): ScopedTestHost {
  const core = createCoreScope({ extra: coreStubs });
  return {
    core,
    child(kind, id, stubs = []) {
      return core.createChild(kind, id, { extra: stubs });
    },
    childOf(parent, kind, id, stubs = []) {
      return parent.createChild(kind, id, { extra: stubs });
    },
    dispose() {
      core.dispose();
    },
  };
}

/** Convenience: seed a single stub pair. */
export function stubPair<T>(
  id: ServiceIdentifier<T>,
  instance: T,
): readonly [ServiceIdentifier<T>, T] {
  return [id, instance];
}
