/**
 * `di` domain (L0) — DI Scope tree (`Scope`, `LifecycleScope`) and scoped service registry.
 */

import { SyncDescriptor } from './descriptors';
import { InstantiationType } from './extensions';
import type { ServiceIdentifier, ServicesAccessor, IInstantiationService } from './instantiation';
import { InstantiationService } from './instantiationService';
import { DisposableStore, type IDisposable } from './lifecycle';
import { ServiceCollection } from './serviceCollection';

export enum LifecycleScope {
  App = 0,
  Session = 1,
  Agent = 2,
}

export interface ScopedEntry {
  readonly scope: LifecycleScope;
  readonly id: ServiceIdentifier<unknown>;
  readonly descriptor: SyncDescriptor<unknown>;
  readonly domain: string;
}

const _scopedRegistry: ScopedEntry[] = [];

export function registerScopedService<T>(
  scope: LifecycleScope,
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  type: InstantiationType = InstantiationType.Delayed,
  domain: string = 'unknown',
): void {
  const descriptor = new SyncDescriptor<T>(
    ctor,
    [],
    type === InstantiationType.Delayed,
  );
  _scopedRegistry.push({
    scope,
    id: id as ServiceIdentifier<unknown>,
    descriptor: descriptor as SyncDescriptor<unknown>,
    domain,
  });
}

export function getScopedServiceDescriptors(scope: LifecycleScope): ReadonlyArray<ScopedEntry> {
  return _scopedRegistry.filter((entry) => entry.scope === scope);
}

export function _clearScopedRegistryForTests(): void {
  _scopedRegistry.length = 0;
}

export type ScopeSeed = ReadonlyArray<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [ServiceIdentifier<any>, unknown]
>;

export interface ScopeOptions {
  readonly id?: string;
  readonly extra?: ScopeSeed;
}

export interface IScopeHandle<K extends LifecycleScope = LifecycleScope> {
  readonly id: string;
  readonly kind: K;
  readonly accessor: ServicesAccessor;
  dispose(): void;
}

export type IAppScopeHandle = IScopeHandle<LifecycleScope.App>;
export type ISessionScopeHandle = IScopeHandle<LifecycleScope.Session>;
export type IAgentScopeHandle = IScopeHandle<LifecycleScope.Agent>;

function buildCollection(kind: LifecycleScope, extra?: ScopeSeed): ServiceCollection {
  const collection = new ServiceCollection();
  for (const entry of _scopedRegistry) {
    if (entry.scope === kind) {
      collection.set(entry.id, entry.descriptor);
    }
  }
  if (extra) {
    for (const [id, value] of extra) {
      collection.set(id, value);
    }
  }
  return collection;
}

export function createScopedChildHandle(
  parent: IInstantiationService,
  kind: LifecycleScope,
  id: string,
  options: ScopeOptions = {},
): IScopeHandle {
  const collection = buildCollection(kind, options.extra);
  const child = parent.createChild(collection);
  const accessor: ServicesAccessor = {
    get: <T>(serviceId: ServiceIdentifier<T>): T =>
      child.invokeFunction((a) => a.get(serviceId)),
  };
  return { id, kind, accessor, dispose: () => child.dispose() };
}

export class Scope implements IDisposable {
  readonly children = new Map<string, Scope>();
  readonly accessor: ServicesAccessor;

  private readonly _store = new DisposableStore();
  private _disposed = false;

  private constructor(
    readonly id: string,
    readonly kind: LifecycleScope,
    readonly instantiation: IInstantiationService,
    private readonly _parent?: Scope,
  ) {
    this.accessor = {
      get: <T>(serviceId: ServiceIdentifier<T>): T =>
        instantiation.invokeFunction((a) => a.get(serviceId)),
    };
  }

  static createApp(options: ScopeOptions = {}): Scope {
    const kind = LifecycleScope.App;
    const collection = buildCollection(kind, options.extra);
    const instantiation = new InstantiationService(collection, true);
    return new Scope(options.id ?? 'app', kind, instantiation);
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(`Scope '${this.id}' has been disposed`);
    }
  }

  createChild(kind: LifecycleScope, id: string, options: ScopeOptions = {}): Scope {
    this._assertNotDisposed();
    if (kind <= this.kind) {
      throw new Error(
        `child scope kind ${LifecycleScope[kind]}(${kind}) must be greater than parent kind ${LifecycleScope[this.kind]}(${this.kind})`,
      );
    }
    if (this.children.has(id)) {
      throw new Error(`Scope '${this.id}' already has a child with id '${id}'`);
    }
    const collection = buildCollection(kind, options.extra);
    const childInstantiation = this.instantiation.createChild(collection);
    const child = new Scope(id, kind, childInstantiation, this);
    this.children.set(id, child);
    return child;
  }

  toHandle(): IScopeHandle {
    return { id: this.id, kind: this.kind, accessor: this.accessor, dispose: () => this.dispose() };
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const kids = Array.from(this.children.values());
    this.children.clear();
    for (const child of kids) {
      child.dispose();
    }

    this._store.dispose();
    this.instantiation.dispose();

    if (this._parent) {
      this._parent.children.delete(this.id);
    }
  }
}

export function createAppScope(options: ScopeOptions = {}): Scope {
  return Scope.createApp(options);
}
