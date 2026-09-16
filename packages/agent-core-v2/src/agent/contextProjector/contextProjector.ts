import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#human/llm/message';

import type { HistoryMessage } from '#human/agent/turn';

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
    messages: readonly HistoryMessage[],
    policy?: ProjectionPolicy,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly HistoryMessage[]): MediaStripSnapshot;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
