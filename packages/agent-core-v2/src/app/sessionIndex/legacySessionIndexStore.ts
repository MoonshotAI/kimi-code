/**
 * `sessionIndex` domain (L2) — private legacy v1 session-index Store contract.
 *
 * Exposes an App-scoped, read-only projection of validated legacy entries to
 * Workspace consumers; the implementation delegates to the domain's legacy
 * persistence leaf.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionIndexLine } from './legacySessionIndexPersistence';

export interface ILegacySessionIndexStore {
  readonly _serviceBrand: undefined;

  readEntries(): Promise<readonly SessionIndexLine[]>;
}

export const ILegacySessionIndexStore: ServiceIdentifier<ILegacySessionIndexStore> =
  createDecorator<ILegacySessionIndexStore>('legacySessionIndexStore');
