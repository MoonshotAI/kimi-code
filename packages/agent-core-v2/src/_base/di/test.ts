/**
 * `di` domain — scoped test host and service-stub helpers for DI domain tests.
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
import { createAppScope, Scope, type ScopeKind, type ScopeSeed } from './scope';

export interface ScopedTestHost {
  readonly app: Scope;
  child(kind: ScopeKind, id: string, stubs?: ScopeSeed): Scope;
  childOf(parent: Scope, kind: ScopeKind, id: string, stubs?: ScopeSeed): Scope;
  dispose(): void;
}

export function createScopedTestHost(appStubs: ScopeSeed = []): ScopedTestHost {
  const app = createAppScope({ seeds: appStubs });
  return {
    app,
    child(kind, id, stubs = []) {
      return app.createChild(kind, id, { seeds: stubs });
    },
    childOf(parent, kind, id, stubs = []) {
      return parent.createChild(kind, id, { seeds: stubs });
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
