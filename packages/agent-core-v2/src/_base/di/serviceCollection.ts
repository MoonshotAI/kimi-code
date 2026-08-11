/**
 * `di` domain — `ServiceCollection`: the dynamic registry (L1).
 *
 * Maps a service id to its recipe (`SyncDescriptor`) or materialized instance.
 * Every write stamps the entry with a container-monotonic `uid` (a generation
 * marker used for introspection and history — it plays no role in change
 * detection) and fires the token's availability event with `{ oldUid, newUid }`.
 */

import { Emitter } from '../event';
import { SyncDescriptor } from './descriptors';
import type { ServiceIdentifier } from './instantiation';
import type { IDisposable } from './lifecycle';

export interface ServiceCollectionEntry<T = unknown> {
  readonly value: T | SyncDescriptor<T>;
  readonly uid: number;
  readonly config?: unknown;
  readonly recipe?: SyncDescriptor<T>;
}

export interface AvailabilityChange {
  readonly oldUid: number | undefined;
  readonly newUid: number | undefined;
}

export class ServiceCollection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _entries = new Map<ServiceIdentifier<any>, ServiceCollectionEntry<any>>();
  private readonly _emitters = new Map<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceIdentifier<any>,
    Emitter<AvailabilityChange>
  >();
  private _nextUid = 0;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...entries: ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>
  ) {
    for (const [id, value] of entries) {
      this.set(id, value);
    }
  }

  set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
    options?: { readonly config?: unknown },
  ): T | SyncDescriptor<T> | undefined {
    const prev = this._entries.get(id);
    const uid = ++this._nextUid;
    this._entries.set(id, {
      value: instanceOrDescriptor,
      uid,
      config: options?.config,
    });
    this._emitterFor(id).fire({ oldUid: prev?.uid, newUid: uid });
    return prev?.value as T | SyncDescriptor<T> | undefined;
  }

  materialize<T>(id: ServiceIdentifier<T>, instance: T): void {
    const prev = this._entries.get(id);
    if (prev === undefined || !(prev.value instanceof SyncDescriptor)) {
      return;
    }
    this._entries.set(id, {
      value: instance,
      uid: prev.uid,
      config: prev.config,
      recipe: prev.value,
    });
  }

  unmaterialize<T>(id: ServiceIdentifier<T>): void {
    const prev = this._entries.get(id);
    if (prev === undefined || prev.recipe === undefined) {
      return;
    }
    this._entries.set(id, {
      value: prev.recipe,
      uid: prev.uid,
      config: prev.config,
    });
  }

  setConfig<T>(id: ServiceIdentifier<T>, config: unknown): void {
    const prev = this._entries.get(id);
    if (prev === undefined) {
      return;
    }
    this._entries.set(id, { ...prev, config });
  }

  delete<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    const prev = this._entries.get(id);
    if (prev === undefined) {
      return undefined;
    }
    this._entries.delete(id);
    this._emitterFor(id).fire({ oldUid: prev.uid, newUid: undefined });
    return prev.value as T | SyncDescriptor<T> | undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry(id: ServiceIdentifier<any>): ServiceCollectionEntry | undefined {
    return this._entries.get(id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uidOf(id: ServiceIdentifier<any>): number | undefined {
    return this._entries.get(id)?.uid;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configOf(id: ServiceIdentifier<any>): unknown {
    return this._entries.get(id)?.config;
  }

  onDidChange<T>(
    id: ServiceIdentifier<T>,
    listener: (change: AvailabilityChange) => void,
  ): IDisposable {
    return this._emitterFor(id).event(listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  has(id: ServiceIdentifier<any>): boolean {
    return this._entries.has(id);
  }

  get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
    return this._entries.get(id)?.value as T | SyncDescriptor<T> | undefined;
  }

  forEach(
    callback: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: ServiceIdentifier<any>,
      value: unknown,
    ) => void,
  ): void {
    this._entries.forEach((entry, id) => { callback(id, entry.value); });
  }

  dispose(): void {
    for (const emitter of this._emitters.values()) {
      emitter.dispose();
    }
    this._emitters.clear();
  }

  private _emitterFor<T>(id: ServiceIdentifier<T>): Emitter<AvailabilityChange> {
    let emitter = this._emitters.get(id);
    if (emitter === undefined) {
      emitter = new Emitter<AvailabilityChange>();
      this._emitters.set(id, emitter);
    }
    return emitter;
  }
}
