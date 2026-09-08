export class SyncDescriptor<T> {
  public readonly ctor: any;

  constructor(
    ctor: new (...args: any[]) => T,
    public readonly staticArguments: ReadonlyArray<any> = [],
  ) {
    this.ctor = ctor;
  }
}

export interface SyncDescriptor0<T> {
  readonly ctor: new () => T;
}
