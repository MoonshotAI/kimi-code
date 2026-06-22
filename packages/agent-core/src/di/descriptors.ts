/**
 * Service descriptors: a `SyncDescriptor` packages a constructor + static
 * args for later instantiation by the container. Modelled after VSCode's
 * `SyncDescriptor`.
 */

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

export interface SyncDescriptor0<T> {
  readonly ctor: new () => T;
}
