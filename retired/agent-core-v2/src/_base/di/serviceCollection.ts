/**
 * `di` domain (L0) — `ServiceCollection` map of service id → descriptor or instance.
 */

import type { SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';

export class ServiceCollection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _entries = new Map<ServiceIdentifier<any>, unknown>();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...entries: ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>
  ) {
    for (const [id, value] of entries) {
      this._entries.set(id, value);
    }
  }

  set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    const prev = this._entries.get(id);
    this._entries.set(id, instanceOrDescriptor);
    return prev as T | SyncDescriptor<T> | undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean {
    return this._entries.has(id);
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    return this._entries.get(id) as T | SyncDescriptor<T> | undefined;
  }

  forEach(
    callback: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: ServiceIdentifier<any>,
      value: unknown,
    ) => void,
  ): void {
    this._entries.forEach((value, id) => callback(id, value));
  }
}
