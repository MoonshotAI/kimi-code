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
import { createAppScope, createScopedChildHandle, Scope, type ScopeKind, type ScopeSeed } from './scope';

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
      if (kind === 'program') {
        const handle = createScopedChildHandle(app.instantiation, kind, id, { seeds: stubs });
        return {
          id: handle.id,
          kind: handle.kind,
          accessor: handle.accessor,
          dispose: () => handle.dispose(),
        } as Scope;
      }
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
