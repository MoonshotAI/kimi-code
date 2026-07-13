import { createDecorator } from "#/_base/di/instantiation";

import type { UndoCut } from './contextOps';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

export interface ContextCompactionInput {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

export interface ContextCompactionResult {
  summary: string;
  contextSummary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  keptUserMessageCount: number;
  keptHeadUserMessageCount?: number;
  droppedCount?: number;
}

export interface IAgentContextMemoryService {
  readonly _serviceBrand: undefined;

  get(): readonly ContextMessage[];

  /** Append one or more already-folded messages (`context.append_message`). */
  append(...messages: readonly ContextMessage[]): void;

  appendLoopEvent(event: LoopRecordedEvent): void;

  /** Drop the entire history (`context.clear`). No-op when already empty. */
  clear(): void;

  /**
   * Remove the trailing `count` real-user prompts and the exchange that follows
   * them (`context.undo`). Returns the computed cut so the caller can surface a
   * `request.invalid` when fewer than `count` prompts were undoable; the model is
   * left untouched in that case.
   */
  undo(count: number): UndoCut;

  /** Rewrite the live history into the v1-compatible compaction handoff shape. */
  applyCompaction(input: ContextCompactionInput): ContextCompactionResult;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
