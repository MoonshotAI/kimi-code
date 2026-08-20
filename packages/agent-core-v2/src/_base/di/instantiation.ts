import type { SyncDescriptor, SyncDescriptor0 } from './descriptors';
import type { CascadeEngine } from './cascadeEngine';
import type { Event } from '../event';
import type { DisposableStore, IDisposable } from './lifecycle';
import type { ServiceCollection } from './serviceCollection';

export type DependencyKind = 'instance' | 'collection' | 'ref';

export namespace _util {
  export const serviceIds = new Map<string, ServiceIdentifier<any>>();
  export const DI_TARGET = '$di$target';
  export const DI_DEPENDENCIES = '$di$dependencies';

  export interface ServiceDependency {
    readonly id: ServiceIdentifier<any>;
    readonly index: number;
    readonly kind: DependencyKind;
  }

  export function getServiceDependencies(
    ctor: DI_TARGET_OBJ,
  ): ServiceDependency[] {
    return ctor[DI_DEPENDENCIES] || [];
  }

  export function getInstanceDependencies(
    ctor: DI_TARGET_OBJ,
  ): ServiceDependency[] {
    return getServiceDependencies(ctor).filter(
      (dependency) => dependency.kind === 'instance',
    );
  }

  export interface DI_TARGET_OBJ extends Function {
    [DI_TARGET]: Function;
    [DI_DEPENDENCIES]: { id: ServiceIdentifier<any>; index: number; kind: DependencyKind }[];
  }
}

export type BrandedService = { _serviceBrand: undefined };

export interface IConstructorSignature<T, Args extends any[] = []> {
  new <Services extends BrandedService[]>(...args: [...Args, ...Services]): T;
}

export type GetLeadingNonServiceArgs<TArgs extends any[]> =
  TArgs extends [] ? []
  : TArgs extends [...infer TFirst, BrandedService] ? GetLeadingNonServiceArgs<TFirst>
  : TArgs;

export interface ServiceIdentifier<T> {
  (target: any, key: string | symbol | undefined, index: number): void;

  readonly type: T;

  toString(): string;
}

function storeServiceDependency(
  id: ServiceIdentifier<any>,
  target: Function,
  index: number,
  kind: DependencyKind = 'instance',
): void {
  const t = target as _util.DI_TARGET_OBJ;
  if (t[_util.DI_TARGET] === target) {
    t[_util.DI_DEPENDENCIES].push({ id, index, kind });
  } else {
    t[_util.DI_DEPENDENCIES] = [{ id, index, kind }];
    t[_util.DI_TARGET] = target;
  }
}

export function storeCustomDependency(
  id: ServiceIdentifier<any>,
  kind: DependencyKind,
  target: any,
  index: number,
): void {
  storeServiceDependency(id, target, index, kind);
}

export function createDecorator<T>(name: string): ServiceIdentifier<T> {
  const existing = _util.serviceIds.get(name);
  if (existing) {
    return existing as ServiceIdentifier<T>;
  }

  const id = function serviceDecorator(
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
  Object.defineProperty(id, SERVICE_IDENTIFIER_MARK, { value: true, enumerable: false });

  _util.serviceIds.set(name, id);
  return id;
}

const SERVICE_IDENTIFIER_MARK = Symbol('serviceIdentifier');

export function isServiceIdentifier(thing: unknown): thing is ServiceIdentifier<unknown> {
  return (
    typeof thing === 'function' &&
    (thing as unknown as Record<symbol, unknown>)[SERVICE_IDENTIFIER_MARK] === true
  );
}

export function refineServiceDecorator<T1, T extends T1>(
  serviceIdentifier: ServiceIdentifier<T1>,
): ServiceIdentifier<T> {
  return serviceIdentifier as ServiceIdentifier<T>;
}

export enum ScopeActivation {
  OnScopeCreated = 0,
  OnDemand = 1,
}

export interface LiveRef<T> {
  readonly current: T | undefined;
  readonly onDidChange: Event<void>;
}

export function ref<T>(
  id: ServiceIdentifier<T>,
): (target: object, key: string | symbol | undefined, index: number) => void {
  return function refDecorator(target: any, _key: string | symbol | undefined, index: number): void {
    if (arguments.length !== 3) {
      throw new Error('@ref-decorator can only be used to decorate a parameter');
    }
    storeServiceDependency(id, target, index, 'ref');
  };
}

export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T;
}

export interface ProvideOptions {
  readonly activation?: 'eager' | 'ondemand';
  readonly config?: unknown;
}

export interface ProvideAllEntry<T = unknown> {
  readonly id: ServiceIdentifier<T>;
  readonly descriptor: SyncDescriptor<T>;
  readonly options?: ProvideOptions;
}

export interface ProvideHandle extends IDisposable {
  readonly uid: number;
}

export interface IInstantiationService {
  readonly _serviceBrand: undefined;

  readonly cascade: CascadeEngine;

  invokeFunction<R, TS extends any[] = []>(
    fn: (accessor: ServicesAccessor, ...args: TS) => R,
    ...args: TS
  ): R;
  createInstance<T>(descriptor: SyncDescriptor0<T>): T;
  createInstance<
    Ctor extends new (
      ...args: any[]
    ) => unknown,
    R extends InstanceType<Ctor>,
  >(
    ctor: Ctor,
    ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>
  ): R;
  createChild(services: ServiceCollection, store?: DisposableStore): IInstantiationService;
  provide<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
    options?: ProvideOptions,
  ): ProvideHandle;
  provideAll(entries: ReadonlyArray<ProvideAllEntry>): void;
  unprovide<T>(id: ServiceIdentifier<T>): void;
  dispose(): void;
}

export const IInstantiationService: ServiceIdentifier<IInstantiationService> =
  createDecorator<IInstantiationService>('instantiationService');

export interface ServiceCollectionLike {
  set<T>(id: ServiceIdentifier<T>, instanceOrDescriptor: any): unknown;
  get<T>(id: ServiceIdentifier<T>): any;
  has(id: ServiceIdentifier<any>): boolean;
  forEach(
    callback: (id: ServiceIdentifier<any>, value: any) => void,
  ): void;
}
