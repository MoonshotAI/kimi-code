import { createDecorator } from "#/_base/di";

import type { UndoCut } from './contextOps';
import type { ContextMessage } from './types';

export interface ContextCompactionInput {
  readonly count: number;
  readonly summary: ContextMessage;
  readonly tokens?: number;
}

export interface IAgentContextMemoryService {
  readonly _serviceBrand: undefined;

  get(): readonly ContextMessage[];

  /** Append one or more already-folded messages (`context.append_message`). */
  append(...messages: readonly ContextMessage[]): void;

  /** Drop the entire history (`context.clear`). No-op when already empty. */
  clear(): void;

  /**
   * Remove the trailing `count` real-user prompts and the exchange that follows
   * them (`context.undo`). Returns the computed cut so the caller can surface a
   * `request.invalid` when fewer than `count` prompts were undoable; the model is
   * left untouched in that case.
   */
  undo(count: number): UndoCut;

  /** Replace the leading `count` messages with a compaction summary (`context.apply_compaction`). */
  applyCompaction(input: ContextCompactionInput): void;

  /**
   * Arbitrary splice (`context.splice`). Retained for replay of protocol 1.5
   * sessions and the few internal single-delete mutations with no 1.4 spelling;
   * new code should prefer the named primitives above.
   */
  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
