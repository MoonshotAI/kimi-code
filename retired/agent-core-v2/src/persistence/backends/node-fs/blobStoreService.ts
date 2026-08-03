/**
 * `blobStore` domain (L2) — `IBlobStore` implementation.
 *
 * Delegates to the `IFileSystemStorageService` backend with atomic writes. Bound at App
 * scope; child scopes (Session, Agent) inherit the same instance and use
 * scope strings to namespace their data.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IBlobStore, type BlobReadRange } from '#/persistence/interface/blobStore';

export class BlobStoreService implements IBlobStore {
  declare readonly _serviceBrand: undefined;

  constructor(@IFileSystemStorageService private readonly storage: IFileSystemStorageService) {}

  async put(scope: string, key: string, data: Uint8Array): Promise<void> {
    await this.storage.write(scope, key, data, { atomic: true });
  }

  async get(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.storage.read(scope, key);
  }

  getStream(scope: string, key: string, range?: BlobReadRange): AsyncIterable<Uint8Array> {
    return this.storage.readStream(scope, key, range);
  }

  async has(scope: string, key: string): Promise<boolean> {
    const keys = await this.storage.list(scope, key);
    return keys.includes(key);
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }
}

registerScopedService(
  LifecycleScope.App,
  IBlobStore,
  BlobStoreService,
  InstantiationType.Eager,
  'blobStore',
);
