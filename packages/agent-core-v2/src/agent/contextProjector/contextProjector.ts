import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Message } from '#/llm-adapter/contract/message';

import type { ContextMessage } from '#/agent/contextMemory/types';

export type ContextFold = (messages: readonly ContextMessage[]) => readonly ContextMessage[];

export const CONTEXT_FOLD_ORDER = {
  COLLAPSE: 0,
  VIEW: 100,
} as const;

export type ContextFoldOrder = (typeof CONTEXT_FOLD_ORDER)[keyof typeof CONTEXT_FOLD_ORDER];

export interface ContextFoldOptions {
  readonly order?: ContextFoldOrder;
}

declare const mediaStripSnapshotBrand: unique symbol;

export interface MediaStripSnapshot {
  readonly [mediaStripSnapshotBrand]: undefined;
}

export interface ProjectionPolicy {
  readonly structure?: 'strict';
  readonly media?: 'degraded' | { readonly strip: MediaStripSnapshot };
  readonly applyFolds?: boolean;
}

export interface IAgentContextProjectorService {
  readonly _serviceBrand: undefined;

  project(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
  ): readonly Message[];

  estimateProjectedTokens(messages: readonly ContextMessage[]): number;

  registerContextFold(id: string, fold: ContextFold, options?: ContextFoldOptions): IDisposable;

  captureMediaStripSnapshot(
    messages: readonly ContextMessage[],
    policy?: ProjectionPolicy,
  ): MediaStripSnapshot;
}

export const IAgentContextProjectorService = createDecorator<IAgentContextProjectorService>(
  'agentContextProjectorService',
);
