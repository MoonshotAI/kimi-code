/**
 * `filestore` domain (cross-cutting) — `IFileStore` implementation.
 *
 * In-memory blob store keyed by string. Persistence to disk (via kaos) is a
 * later step.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IKaosFactory } from '#/kaos/kaos';

import { IFileStore } from './filestore';

export class FileStore implements IFileStore {
  declare readonly _serviceBrand: undefined;
  private readonly blobs = new Map<string, Uint8Array>();

  constructor(@IKaosFactory _kaosFactory: IKaosFactory) {}

  put(key: string, data: Uint8Array): Promise<void> {
    this.blobs.set(key, data);
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.blobs.get(key));
  }
  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Core, IFileStore, FileStore, InstantiationType.Delayed, 'filestore');
