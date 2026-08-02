/**
 * Local port of the DI decorator primitives from the retired engine package
 * `@moonshot-ai/agent-core-v2` — source:
 * `packages/agent-core-v2/src/_base/di/instantiation.ts`.
 *
 * kimi-inspect uses exactly two things from the v2 DI layer:
 *   - the `ServiceIdentifier<T>` contract, and
 *   - `createDecorator(name)`, whose `String(id)` yields the wire channel
 *     name that the debug-RPC client (`src/channel/client.ts`) puts in the
 *     URL and that kap-server's channel registry is keyed by.
 *
 * The service decorators (IConfigService, ISessionLifecycleService, …) are
 * re-created locally in `./services.ts` with the SAME names, so both sides of
 * the wire keep agreeing. Nothing else from the v2 DI layer (instantiation
 * service, scopes, service collections, bootstrap) is used by this app and
 * was not ported.
 *
 * Ported from the v2 source, minus its unused exports — the semantics below
 * must not drift from the original (the `toString` name is the wire
 * contract).
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
