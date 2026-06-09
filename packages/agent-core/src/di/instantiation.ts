/**
 * Core DI types: service identifiers (decorators), accessor, and the public
 * `IInstantiationService` interface. Modelled after VSCode's
 * `InstantiationService`.
 *
 * The container itself lives in `./instantiationService.ts`; this file only
 * defines the brands and contracts so `serviceCollection.ts` can stay free of
 * container code.
 *
 * P0.3 alignment with krow / VSCode:
 *  - `createDecorator(name)` is now singleton-per-name: calling it twice with
 *    the same `name` returns the same identifier. (Previously every call
 *    minted a fresh callable.)
 *  - Decorator body actually stashes `{ id, index }` on the ctor as
 *    `$di$dependencies` own-property metadata (instead of being a no-op).
 *    `InstantiationService._createInstance` does not yet consume this — that
 *    wiring lands in P1.1 — so the daemon's existing
 *    `ix.createInstance(Impl, a.get(IDepA), ...)` call sites remain
 *    bytewise unchanged.
 *  - `ServiceIdentifier<T>` exposes `_serviceBrand` (krow naming) instead of
 *    the prior internal `$serviceMarker`.
 *
 * P0.4 alignment:
 *  - `BrandedService` + `GetLeadingNonServiceArgs` type tools added so the
 *    `createInstance(ctor, ...rest)` signature can trim trailing service
 *    parameters once `@IFoo` auto-injection lands in P1.1.
 *  - `IInstantiationService.createInstance` gains a `SyncDescriptor0<T>`
 *    overload mirroring krow.
 */

import type { SyncDescriptor0 } from './descriptors';

/**
 * Internal metadata utilities shared with `instantiationService.ts`. Not
 * re-exported from `./index.ts` — this is a private contract between the
 * decorator factory and the container.
 */
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

/** Branded service shape used by `GetLeadingNonServiceArgs` and friends. */
export type BrandedService = { _serviceBrand: undefined };

/**
 * Type-level slicer that retains only the leading non-`BrandedService` args
 * of a constructor parameter list. Used by `createInstance(ctor, ...args)`
 * so callers can omit any trailing `@IFoo`-decorated service parameters
 * (those are auto-injected by the container in a later phase). Mirrors krow
 * `instantiation.ts:32-35`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GetLeadingNonServiceArgs<TArgs extends any[]> =
  TArgs extends [] ? []
  : TArgs extends [...infer TFirst, BrandedService] ? GetLeadingNonServiceArgs<TFirst>
  : TArgs;

/**
 * A branded identifier for a service. At the value level a `ServiceIdentifier`
 * is callable so it can stand in as a TypeScript parameter decorator
 * (`constructor(@ILogger logger: ILogger)`). The brand field is never read
 * at runtime; it exists purely to keep the structural type unique per-id and
 * to carry the human-readable name for diagnostics.
 */
export interface ServiceIdentifier<T> {
  // Parameter-decorator callable signature. Now consumed:
  // `storeServiceDependency(id, target, index)` is called on application.
  // `key` is `undefined` for constructor-parameter decorators (TS calls
  // parameter decorators on constructors with no property key).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target: any, key: string | symbol | undefined, index: number): void;

  /** Phantom marker so two decorators with different `T` are not assignable. */
  readonly _serviceBrand: { readonly _: T };

  toString(): string;
}

/**
 * Append `{ id, index }` to the ctor's `$di$dependencies` own-property metadata
 * array. If the ctor already has an own `$di$target` pointing at itself the
 * metadata array is mine — push. Otherwise (likely inherited from a parent
 * class via prototype lookup) reinitialise so subclasses don't accidentally
 * mutate the parent's array.
 */
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

/**
 * Mints a service identifier. **Singleton per name** — calling
 * `createDecorator('logger')` twice returns the same identifier. This is a
 * deliberate behavior change to align with VSCode / krow; the previous
 * implementation minted a fresh callable on every call.
 */
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

/**
 * Narrows a service identifier to a more specific subtype. Mirrors krow
 * `instantiation.ts:82-84`.
 */
export function refineServiceDecorator<T1, T extends T1>(
  serviceIdentifier: ServiceIdentifier<T1>,
): ServiceIdentifier<T> {
  return serviceIdentifier as ServiceIdentifier<T>;
}

/**
 * The accessor handed to `invokeFunction(fn)` callbacks. The only way to
 * resolve a service from outside the container is via this object — which
 * makes it trivial to swap containers for testing.
 */
export interface ServicesAccessor {
  get<T>(id: ServiceIdentifier<T>): T;
}

/**
 * The runtime container. See `./instantiationService.ts` for the
 * implementation.
 */
export interface IInstantiationService {
  readonly _serviceBrand: undefined;

  invokeFunction<R>(fn: (accessor: ServicesAccessor) => R): R;
  /**
   * Construct a class via a `SyncDescriptor` packaging its ctor + static args.
   * Mirrors the krow / VSCode `createInstance(descriptor)` overload — useful
   * when callers want a single value to pass around (e.g. for registration).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createInstance<T>(descriptor: SyncDescriptor0<T>): T;
  /**
   * Construct a class with positional arguments. `GetLeadingNonServiceArgs`
   * trims any trailing `@IFoo`-decorated service parameters off the inferred
   * signature so callers only have to supply the non-service prefix; the
   * container auto-injects the service tail (auto-injection itself lands in
   * P1.1 — this commit only widens the type).
   */
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
  createChild(services: ServiceCollectionLike): IInstantiationService;
  dispose(): void;
}

/**
 * Service identifier for the container itself. `IInstantiationService` is
 * both a TypeScript interface and a runtime value (TS allows
 * interface/value coexistence under the same name). With this in place any
 * service ctor that adds `@IInstantiationService` to a parameter receives
 * the live container — enabling factory and per-request-scope patterns. The
 * container's own constructor stamps `this._services.set(IInstantiationService, this)`
 * so child containers see their own slot, not the parent's.
 */
export const IInstantiationService: ServiceIdentifier<IInstantiationService> =
  createDecorator<IInstantiationService>('IInstantiationService');

/**
 * Structural alias to avoid a circular import with `./serviceCollection.ts`.
 * Anything `ServiceCollection`-shaped (set/get/has/forEach) satisfies this.
 */
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
