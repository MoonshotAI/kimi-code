/**
 * `di` domain — `SyncDescriptor` packaging a constructor and its static arguments.
 */

export class SyncDescriptor<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly ctor: any;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor: new (...args: any[]) => T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly staticArguments: ReadonlyArray<any> = [],
  ) {
    this.ctor = ctor;
  }
}

export interface SyncDescriptor0<T> {
  readonly ctor: new () => T;
}
