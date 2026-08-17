import { createDecorator } from "#/_base/di/instantiation";

import type { UndoCut } from './conversationTime';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

export interface ContextCompactionInput {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  /** Measured output tokens of the compaction LLM exchange (the REAL summary
   *  size); preferred over the summary-text estimate in the `tokensAfter`
   *  fallback when present. */
  readonly summaryOutputTokens?: number;
  /** Estimated fixed request overhead (system prompt + non-deferred tool
   *  schemas) that every post-compaction exchange still carries. Counted into
   *  the `tokensAfter` fallback so the result stays on the same full-request
   *  basis as the measured exchange anchors. */
  readonly requestOverheadTokens?: number;
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

  /** The model-visible window: the append-only folded log derived through
   *  `visibleWindow.deriveVisibleMessages` (compaction markers folded away).
   *  This is the history every consumer — LLM requests, token counting, undo,
   *  injections — should read. */
  get(): readonly ContextMessage[];

  /** The raw append-only folded log, pre-compaction history and summary
   *  markers included. Log entries keep stable identities across appends —
   *  use it for integrity checks (e.g. the compaction safety check), never
   *  for model-facing content. */
  getLog(): readonly ContextMessage[];

  append(...messages: readonly ContextMessage[]): void;

  appendLoopEvent(event: LoopRecordedEvent): void;

  publishTrailingRemoval(previous: readonly ContextMessage[]): boolean;

  clear(): void;

  undo(count: number): UndoCut;

  applyCompaction(input: ContextCompactionInput): ContextCompactionResult;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
