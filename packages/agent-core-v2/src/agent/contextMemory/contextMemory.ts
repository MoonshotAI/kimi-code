/**
 * Declares the Agent-scoped context-memory contract and compaction handoff
 * data shared by request, token-counting, and persistence consumers.
 */

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
  readonly summaryOutputTokens?: number;
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

  get(): readonly ContextMessage[];

  getMessageLog(): readonly ContextMessage[];

  append(...messages: readonly ContextMessage[]): void;

  appendLoopEvent(event: LoopRecordedEvent): void;

  publishTrailingRemoval(previous: readonly ContextMessage[]): boolean;

  clear(): void;

  undo(count: number): UndoCut;

  applyCompaction(input: ContextCompactionInput): ContextCompactionResult;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
