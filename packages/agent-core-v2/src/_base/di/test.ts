/**
 * `di` domain (L0) — scoped test host and service-stub helpers for DI domain tests.
 */

export {
  createServices,
  TestInstantiationService,
} from './testInstantiationService';
export type { ServiceIdCtorPair } from './testInstantiationService';

import { type ServiceIdentifier } from './instantiation';
import { createCoreScope, LifecycleScope, Scope, type ScopeSeed } from './scope';

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

export function stubPair<T>(
  id: ServiceIdentifier<T>,
  instance: T,
): readonly [ServiceIdentifier<T>, T] {
  return [id, instance];
}
