/**
 * `di` domain — service identifiers, `createDecorator`, and the `IInstantiationService` contract.
 */

import type { SyncDescriptor, SyncDescriptor0 } from './descriptors';
import type { CascadeEngine } from './cascadeEngine';
import type { DisposableStore, IDisposable } from './lifecycle';
import type { ServiceCollection } from './serviceCollection';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace _util {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const serviceIds = new Map<string, ServiceIdentifier<any>>();
  export const DI_TARGET = '$di$target';
  export const DI_DEPENDENCIES = '$di$dependencies';

  export function getServiceDependencies(
    ctor: DI_TARGET_OBJ,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): { id: ServiceIdentifier<any>; index: number }[] {
    return ctor[DI_DEPENDENCIES] || [];
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  export interface DI_TARGET_OBJ extends Function {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    [DI_TARGET]: Function;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [DI_DEPENDENCIES]: { id: ServiceIdentifier<any>; index: number }[];
  }
}

export type BrandedService = { _serviceBrand: undefined };

export interface IConstructorSignature<T, Args extends any[] = []> {
  new <Services extends BrandedService[]>(...args: [...Args, ...Services]): T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GetLeadingNonServiceArgs<TArgs extends any[]> =
  TArgs extends [] ? []
  : TArgs extends [...infer TFirst, BrandedService] ? GetLeadingNonServiceArgs<TFirst>
  : TArgs;

export interface ServiceIdentifier<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target: any, key: string | symbol | undefined, index: number): void;

  readonly type: T;

  toString(): string;
}

function storeServiceDependency(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: ServiceIdentifier<any>,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  target: Function,
  index: number,
): void {
  const t = target as _util.DI_TARGET_OBJ;
  if (t[_util.DI_TARGET] === target) {
    t[_util.DI_DEPENDENCIES].push({ id, index });
  } else {
    t[_util.DI_DEPENDENCIES] = [{ id, index }];
    t[_util.DI_TARGET] = target;
  }
}

export function createDecorator<T>(name: string): ServiceIdentifier<T> {
  const existing = _util.serviceIds.get(name);
  if (existing) {
    return existing as ServiceIdentifier<T>;
  }

  const id = function serviceDecorator(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    target: any,
    _key: string | symbol | undefined,
    index: number,
  ): void {
    if (arguments.length !== 3) {
      throw new Error(
        '@IServiceName-decorator can only be used to decorate a parameter',
      );
    }
    storeServiceDependency(id, target, index);
  } as unknown as ServiceIdentifier<T>;

  Object.defineProperty(id, 'toString', {
    value: function toString(): string {
      return name;
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });

  _util.serviceIds.set(name, id);
  return id;
}

export function refineServiceDecorator<T1, T extends T1>(
  serviceIdentifier: ServiceIdentifier<T1>,
): ServiceIdentifier<T> {
  return serviceIdentifier as ServiceIdentifier<T>;
}

export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T;
}

export interface ProvideOptions {
  /** Cascade-line metadata (L4): a pinned unit never joins a cascade. */
  readonly pinned?: boolean;
  /**
   * `eager` (default): the unit activates as soon as its dependencies are
   * satisfied. `ondemand`: it materializes at first resolution (a cascade-torn
   * unit always rebuilds regardless).
   */
  readonly activation?: 'eager' | 'ondemand';
}

/**
 * Handle to one `provide` registration: it is an entry in the provider's
 * ledger, so disposing the handle unprovides the token. (Grows into the full
 * FiberHandle — thenable / state / update — in Phase 3.)
 */
export interface ProvideHandle extends IDisposable {
  readonly uid: number;
}

export interface IInstantiationService {
  readonly _serviceBrand: undefined;

  /** Cascade engine (L2): per-container facade over the tree-wide orchestrated transactions. */
  readonly cascade: CascadeEngine;

  invokeFunction<R, TS extends any[] = []>(
    fn: (accessor: ServicesAccessor, ...args: TS) => R,
    ...args: TS
  ): R;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(descriptor: SyncDescriptor0<T>): T;
  createInstance<
    Ctor extends new (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...args: any[]
    ) => unknown,
    R extends InstanceType<Ctor>,
  >(
    ctor: Ctor,
    ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>
  ): R;
  createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService;
  /**
   * Register (or replace) a token at runtime. Replacing retires the previous
   * materialized instance before the new generation becomes visible.
   */
  provide<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
    options?: ProvideOptions,
  ): ProvideHandle;
  /** Remove a token, retiring its materialized instance. No-op when absent. */
  unprovide<T>(id: ServiceIdentifier<T>): void;
  dispose(): void;
}

export const IInstantiationService: ServiceIdentifier<IInstantiationService> =
  createDecorator<IInstantiationService>('instantiationService');

export interface ServiceCollectionLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set<T>(id: ServiceIdentifier<T>, instanceOrDescriptor: any): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get<T>(id: ServiceIdentifier<T>): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean;
  forEach(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (id: ServiceIdentifier<any>, value: any) => void,
  ): void;
}
