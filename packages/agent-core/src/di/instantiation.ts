import type { SyncDescriptor0 } from './descriptors';
import type { DisposableStore } from './lifecycle';
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

export interface IInstantiationService {
  readonly _serviceBrand: undefined;

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
