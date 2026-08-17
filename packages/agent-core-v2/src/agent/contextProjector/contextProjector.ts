/**
 * `contextProjector` domain — Agent-scope context projection contract.
 *
 * Defines wire-safe history projections and an opaque snapshot of the media
 * identities that a provider rejected, allowing later steps to strip only
 * that content while preserving newly generated recovery media.
 *
 * Projection variability is expressed as data: a `ProjectionPolicy` —
 * `structure: 'strict'` adds the structural repairs strict providers need
 * (duplicate tool calls dropped, consecutive assistants merged, leading
 * non-user messages dropped); `media` selects the provider-rejection
 * fallback (`'degraded'` replaces all but the most recent media with text
 * markers after an HTTP 413; `{ strip }` replaces exactly the snapshotted
 * media identities after a rejected-format or still-too-large resend).
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: 'degraded' | { readonly strip: MediaStripSnapshot };
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
