/**
 * `persistence/interface` — `IBlobStore` contract.
 *
 * The blob access-pattern Store: write-once, key-addressed, potentially large
 * objects. Sits alongside `IAppendLogStore` and `IAtomicDocumentStore` as the
 * third generic access-pattern Store in the three-layer persistence model.
 *
 * Business services that need blob storage (`IFileService`, `IAgentBlobService`)
 * depend on this interface rather than on the raw `IFileSystemStorageService`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IBlobStore {
  readonly _serviceBrand: undefined;

  put(scope: string, key: string, data: Uint8Array): Promise<void>;
  get(scope: string, key: string): Promise<Uint8Array | undefined>;
  getStream(scope: string, key: string, range?: BlobReadRange): AsyncIterable<Uint8Array>;
  has(scope: string, key: string): Promise<boolean>;
  delete(scope: string, key: string): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
}

export interface BlobReadRange {
  readonly start: number;
  readonly end: number;
}

export const IBlobStore: ServiceIdentifier<IBlobStore> =
  createDecorator<IBlobStore>('blobStore');
