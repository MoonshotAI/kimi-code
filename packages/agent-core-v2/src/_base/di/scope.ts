/**
 * `di` domain — DI Scope tree (`Scope`) and scoped service registry.
 *
 * Scoped services are resolved when their scope is created by default;
 * registrations that defer construction until first resolution use `OnDemand`.
 *
 * The kernel only knows the scope tree and the `ScopeKind` partial order.
 * The tier set is a business concept: the host bootstrap declares it through
 * `setScopeTopology` (see `src/app/scopes.ts`).
 */

import { BugIndicatingError } from '../errors/errors';
import { SyncDescriptor } from './descriptors';
import { ScopeActivation, type ProvideAllEntry } from './instantiation';
import type { ServiceIdentifier, ServicesAccessor, IInstantiationService } from './instantiation';
import { InstantiationService } from './instantiationService';
import { DisposableStore, type IDisposable } from './lifecycle';
import { Ledger, type LedgerEntry } from '../lifecycle/ledger';
import { ServiceCollection } from './serviceCollection';
import { watchScopeUnits } from './scopeUnits';

export { ScopeActivation };

export type ScopeKind = string;

let _scopeTopology: readonly string[] | undefined;

export function setScopeTopology(kinds: readonly string[]): void {
  if (_scopeTopology === undefined) {
    _scopeTopology = [...kinds];
    return;
  }
  if (
    _scopeTopology.length === kinds.length &&
    _scopeTopology.every((kind, index) => kind === kinds[index])
  ) {
    return;
  }
  throw new BugIndicatingError(
    `scope topology already declared as [${_scopeTopology.join(', ')}]; cannot redeclare as [${kinds.join(', ')}]`,
  );
}

export interface ScopedEntry {
  readonly scope: ScopeKind;
  readonly id: ServiceIdentifier<unknown>;
  readonly descriptor: SyncDescriptor<unknown>;
  readonly domain: string;
  readonly activation: ScopeActivation;
}

const _scopedRegistry: ScopedEntry[] = [];

export function registerScopedService<T>(
  scope: ScopeKind,
  id: ServiceIdentifier<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  activation: ScopeActivation = ScopeActivation.OnScopeCreated,
  domain: string = 'unknown',
): void {
  const descriptor = new SyncDescriptor<T>(ctor);
  _scopedRegistry.push({
    scope,
    id: id as ServiceIdentifier<unknown>,
    descriptor: descriptor as SyncDescriptor<unknown>,
    domain,
    activation,
  });
}

export function getScopedServiceDescriptors(scope: ScopeKind): ReadonlyArray<ScopedEntry> {
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
  readonly seeds?: ScopeSeed;
  readonly configureContainer?: (container: InstantiationService) => void;
}

export interface IScopeHandle<K extends ScopeKind = ScopeKind> {
  readonly id: string;
  readonly kind: K;
  readonly accessor: ServicesAccessor;
  dispose(): void;
}

export type IAppScopeHandle = IScopeHandle<'app'>;
export type IWorkspaceScopeHandle = IScopeHandle<'workspace'>;
export type ISessionScopeHandle = IScopeHandle<'session'>;
export type IAgentScopeHandle = IScopeHandle<'agent'>;

function buildCollection(seeds?: ScopeSeed): ServiceCollection {
  const collection = new ServiceCollection();
  if (seeds) {
    for (const [id, value] of seeds) {
      collection.set(id, value);
    }
  }
  return collection;
}

function provideScopeServices(
  instantiation: IInstantiationService,
  kind: ScopeKind,
  collection: ServiceCollection,
): void {
  const entries: ProvideAllEntry[] = [];
  for (const entry of _scopedRegistry) {
    if (entry.scope !== kind || collection.get(entry.id) !== undefined) {
      continue;
    }
    entries.push({
      id: entry.id,
      descriptor: entry.descriptor,
      options: {
        activation: entry.activation === ScopeActivation.OnDemand ? 'ondemand' : 'eager',
      },
    });
  }
  instantiation.provideAll(entries);
}

export function createScopedChildHandle(
  parent: IInstantiationService,
  kind: ScopeKind,
  id: string,
  options: ScopeOptions = {},
): IScopeHandle {
  const collection = buildCollection(options.seeds);
  const child = parent.createChild(collection);
  (child as InstantiationService).debugLabel = id;
  try {
    watchScopeUnits(child as InstantiationService, kind);
    options.configureContainer?.(child as InstantiationService);
    provideScopeServices(child, kind, collection);
  } catch (error) {
    child.dispose();
    throw error;
  }
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
  private readonly _ledger: Ledger;
  private _ledgerEntry: LedgerEntry | undefined;
  private _disposed = false;

  private constructor(
    readonly id: string,
    readonly kind: ScopeKind,
    readonly instantiation: IInstantiationService,
    private readonly _parent?: Scope,
  ) {
    this._ledger = new Ledger(`scope:${id}`);
    this._ledger.register(() => {
      this.instantiation.dispose();
    }, 'instantiation');
    this._ledger.register(() => {
      this._store.dispose();
    }, 'store');
    this.accessor = {
      get: <T>(serviceId: ServiceIdentifier<T>): T =>
        instantiation.invokeFunction((a) => a.get(serviceId)),
    };
  }

  get ledger(): Ledger {
    return this._ledger;
  }

  static createApp(options: ScopeOptions = {}): Scope {
    const kind: ScopeKind = 'app';
    const collection = buildCollection(options.seeds);
    const instantiation = new InstantiationService(collection, true);
    instantiation.debugLabel = options.id ?? 'app';
    try {
      watchScopeUnits(instantiation, kind);
      options.configureContainer?.(instantiation);
      provideScopeServices(instantiation, kind, collection);
    } catch (error) {
      instantiation.dispose();
      throw error;
    }
    return new Scope(options.id ?? 'app', kind, instantiation);
  }

  private _assertNotDisposed(): void {
    if (this._disposed) {
      throw new Error(`Scope '${this.id}' has been disposed`);
    }
  }

  createChild(kind: ScopeKind, id: string, options: ScopeOptions = {}): Scope {
    this._assertNotDisposed();
    if (_scopeTopology !== undefined) {
      const parentIndex = _scopeTopology.indexOf(this.kind);
      const childIndex = _scopeTopology.indexOf(kind);
      if (parentIndex === -1 || childIndex === -1 || childIndex <= parentIndex) {
        throw new Error(
          `child scope kind '${kind}' must be greater than parent kind '${this.kind}' in the declared scope topology`,
        );
      }
    }
    if (this.children.has(id)) {
      throw new Error(`Scope '${this.id}' already has a child with id '${id}'`);
    }
    const collection = buildCollection(options.seeds);
    const childInstantiation = this.instantiation.createChild(collection);
    (childInstantiation as InstantiationService).debugLabel = id;
    try {
      watchScopeUnits(childInstantiation as InstantiationService, kind);
      options.configureContainer?.(childInstantiation as InstantiationService);
      provideScopeServices(childInstantiation, kind, collection);
    } catch (error) {
      childInstantiation.dispose();
      throw error;
    }
    const child = new Scope(id, kind, childInstantiation, this);
    this.children.set(id, child);
    child._ledgerEntry = this._ledger.register(() => {
      child.dispose();
    }, `scope:${id}`);
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

    this._ledgerEntry?.release();
    this._ledgerEntry = undefined;
    try {
      void this._ledger.teardown('scope-close');
    } finally {
      this.children.clear();
      if (this._parent) {
        this._parent.children.delete(this.id);
      }
    }
  }
}

export function createAppScope(options: ScopeOptions = {}): Scope {
  return Scope.createApp(options);
}
