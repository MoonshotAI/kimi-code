/**
 * `di` domain (L0) — scoped test host and service-stub helpers for DI domain tests.
 */

export {
  createServices,
  TestInstantiationService,
} from './testInstantiationService';
export type {
  CreateServicesOptions,
  ServiceGroup,
  ServiceRegistration,
} from './testInstantiationService';

import { type ServiceIdentifier } from './instantiation';
import { createAppScope, LifecycleScope, Scope, type ScopeSeed } from './scope';

export interface ScopedTestHost {
  readonly app: Scope;
  child(kind: LifecycleScope, id: string, stubs?: ScopeSeed): Scope;
  childOf(parent: Scope, kind: LifecycleScope, id: string, stubs?: ScopeSeed): Scope;
  dispose(): void;
}

export function createScopedTestHost(appStubs: ScopeSeed = []): ScopedTestHost {
  const app = createAppScope({ extra: appStubs });
  return {
    app,
    child(kind, id, stubs = []) {
      return app.createChild(kind, id, { extra: stubs });
    },
    childOf(parent, kind, id, stubs = []) {
      return parent.createChild(kind, id, { extra: stubs });
    },
    dispose() {
      app.dispose();
    },
  };
}

export function stubPair<T>(
  id: ServiceIdentifier<T>,
  instance: T,
): readonly [ServiceIdentifier<T>, T] {
  return [id, instance];
}
