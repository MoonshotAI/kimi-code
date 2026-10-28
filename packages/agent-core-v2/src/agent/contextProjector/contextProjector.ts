import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/llm-adapter/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export type MediaProjection =
  | { readonly degradeCount: number }
  | { readonly strip: MediaStripSnapshot };

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: MediaProjection;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
    mediaPaths?: ReadonlyMap<string, string>,
  ): readonly Message[];
  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot;
  captureMediaDegradeCount(messages: readonly ContextMessage[]): number;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
