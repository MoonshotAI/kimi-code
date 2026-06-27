/**
 * `InMemoryStorageService` — `IStorageService` backed by in-memory maps.
 *
 * Registered as the default `IStorageService` so scopes and tests work out of
 * the box. For durable production storage, the composition root seeds a
 * `FileStorageService` (rooted at the session directory) into the scope via
 * `ScopeOptions.extra`, overriding this default — the same pattern
 * `blobStoreService` uses.
 *
 * `append` concatenates into the same key slot `write` replaces, mirroring the
 * file implementation's single-namespace semantics so the two are
 * interchangeable for the facades above.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  IStorageService,
  type StorageAppendOptions,
  type StorageWriteOptions,
} from './storageService';

export class InMemoryStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly scopes = new Map<string, Map<string, Uint8Array>>();

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.scopes.get(scope)?.get(key);
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageWriteOptions = {},
  ): Promise<void> {
    this.bucket(scope).set(key, data);
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageAppendOptions = {},
  ): Promise<void> {
    const bucket = this.bucket(scope);
    const existing = bucket.get(key);
    if (existing === undefined) {
      bucket.set(key, data);
      return;
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength);
    merged.set(existing, 0);
    merged.set(data, existing.byteLength);
    bucket.set(key, merged);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const bucket = this.scopes.get(scope);
    if (bucket === undefined) return [];
    const keys = [...bucket.keys()];
    return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  private bucket(scope: string): Map<string, Uint8Array> {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    return bucket;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IStorageService,
  InMemoryStorageService,
  InstantiationType.Delayed,
  'storage',
);
