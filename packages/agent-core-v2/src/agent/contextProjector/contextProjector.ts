/**
 * `contextProjector` domain (L4) — Agent-scope context projection contract.
 *
 * Defines wire-safe history projections and an opaque snapshot of the media
 * identities that a provider rejected, allowing later steps to strip only
 * that content while preserving newly generated recovery media.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/app/llmProtocol/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

/** Opaque provider-visible media identities captured at a strip transition. */
export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(messages: readonly ContextMessage[]): readonly Message[];
  projectStrict(messages: readonly ContextMessage[]): readonly Message[];
  projectMediaDegraded(messages: readonly ContextMessage[]): readonly Message[];
  /** Capture only media that survives the normal provider projection. */
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
  /**
   * Strip the captured identities. Omitting `snapshot` preserves the legacy
   * one-shot behavior by capturing and stripping every currently visible item.
   */
  projectMediaStripped(
    messages: readonly ContextMessage[],
    snapshot?: MediaStripSnapshot,
  ): readonly Message[];
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
