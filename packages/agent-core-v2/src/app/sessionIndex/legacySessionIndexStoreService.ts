/**
 * `sessionIndex` domain (L2) — legacy v1 session-index Store implementation.
 *
 * Delegates legacy persistence decoding to the domain's persistence leaf.
 * Depends only on App-scoped filesystem storage and is bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { ILegacySessionIndexStore } from './legacySessionIndexStore';
import {
  readSessionIndexEntries,
  type SessionIndexLine,
} from './legacySessionIndexPersistence';

export class LegacySessionIndexStoreService implements ILegacySessionIndexStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {}

  readEntries(): Promise<readonly SessionIndexLine[]> {
    return readSessionIndexEntries(this.storage);
  }
}

registerScopedService(
  LifecycleScope.App,
  ILegacySessionIndexStore,
  LegacySessionIndexStoreService,
  InstantiationType.Eager,
  'sessionIndex',
);
