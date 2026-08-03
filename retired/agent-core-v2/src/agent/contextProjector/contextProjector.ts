/**
 * `contextProjector` domain (L4) — Agent-scope context projection contract.
 *
 * Defines wire-safe history projections and an opaque snapshot of the media
 * identities that a provider rejected, allowing later steps to strip only
 * that content while preserving newly generated recovery media.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[]): readonly Message[];
  projectStrict(messages: readonly ContextMessage[]): readonly Message[];
  projectMediaDegraded(messages: readonly ContextMessage[]): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
  projectMediaStripped(
    messages: readonly ContextMessage[],
    snapshot?: MediaStripSnapshot,
  ): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
