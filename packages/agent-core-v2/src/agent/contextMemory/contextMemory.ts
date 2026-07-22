import { createDecorator } from "#/_base/di/instantiation";

import type { UndoCut } from './contextOps';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage, PromptOrigin } from './types';

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

  append(...messages: readonly ContextMessage[]): void;

  /** Append a tagged user message. Content is stored pure; the tag is applied at projection time. */
  appendTagged(content: string, tag: string, origin: PromptOrigin): ContextMessage;

  appendLoopEvent(event: LoopRecordedEvent): void;

  clear(): void;

  undo(count: number): UndoCut;

  applyCompaction(input: ContextCompactionInput): ContextCompactionResult;
}

export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
