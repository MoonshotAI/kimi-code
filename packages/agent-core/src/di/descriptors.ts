/**
 * Service descriptors: a `SyncDescriptor` packages a constructor + static
 * args for later instantiation by the container. Modelled after VSCode's
 * `SyncDescriptor`.
 */

/** How a service is instantiated. Delayed support lands in a later phase. */
export enum InstantiationType {
  /** Construct immediately on first `get`. */
  Eager = 0,
  /** Construct lazily via a Proxy when a method is actually called. */
  Delayed = 1,
}

/**
 * Wraps a constructor plus optional static arguments. The container picks up
 * a `SyncDescriptor` from the `ServiceCollection` (rather than an already-
 * built instance) and constructs it on first `get`.
 */
export class SyncDescriptor<T> {
  // Match VSCode: the constructor argument is typed for callers, while the
  // stored ctor is runtime metadata-bearing and consumed by DI internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly ctor: any;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly staticArguments: ReadonlyArray<any> = [],
    public readonly supportsDelayedInstantiation: boolean = false,
  ) {
    this.ctor = ctor;
  }
}

/**
 * `SyncDescriptor0<T>` is the no-static-args specialisation used by the
 * `createInstance(descriptor)` overload at the type level so a zero-arg ctor
 * descriptor type-checks with no extra rest args. Mirrors krow
 * `descriptors.ts:13-17`.
 */
export class SyncDescriptor0<T> extends SyncDescriptor<T> {
  constructor(ctor: new () => T) {
    super(ctor, []);
  }
}
