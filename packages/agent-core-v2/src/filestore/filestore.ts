/**
 * `filestore` domain (cross-cutting) — core-scope blob/file store.
 *
 * Defines the public contract of the file store: the `IFileStore` used by
 * other domains to store and retrieve opaque blobs by key. Core-scoped — one
 * shared instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IFileStore {
  readonly _serviceBrand: undefined;
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

export const IFileStore: ServiceIdentifier<IFileStore> =
  createDecorator<IFileStore>('fileStore');
