/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

const contextMessageSchema = z.custom<ContextMessage>();
const loopRecordedEventSchema = z.custom<LoopRecordedEvent>();

const contextAppendMessageSchema = z.object({
  agentId: z.string(),
  message: contextMessageSchema,
});

export class ContextAppendMessage extends AgentEvent2<
  z.infer<typeof contextAppendMessageSchema>
> {
  static override readonly type = 'context.append_message';
  static override readonly durable = true;
  static override readonly schema = contextAppendMessageSchema;
}
export interface ContextAppendMessage {
  readonly agentId: string;
  readonly message: ContextMessage;
}

const contextAppendLoopEventSchema = z.object({
  agentId: z.string(),
  event: loopRecordedEventSchema,
});

export class ContextAppendLoopEvent extends AgentEvent2<
  z.infer<typeof contextAppendLoopEventSchema>
> {
  static override readonly type = 'context.append_loop_event';
  static override readonly durable = true;
  static override readonly schema = contextAppendLoopEventSchema;
}
export interface ContextAppendLoopEvent {
  readonly agentId: string;
  readonly event: LoopRecordedEvent;
}

const contextClearSchema = z.object({ agentId: z.string() });

export class ContextClear extends AgentEvent2<z.infer<typeof contextClearSchema>> {
  static override readonly type = 'context.clear';
  static override readonly durable = true;
  static override readonly schema = contextClearSchema;
}
export interface ContextClear {
  readonly agentId: string;
}

const contextCompactionBaseShape = {
  agentId: z.string(),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  summaryOutputTokens: z.number().optional(),
  keptUserMessageCount: z.number().optional(),
  keptHeadUserMessageCount: z.number().optional(),
  droppedCount: z.number().optional(),
  legacyTail: z.boolean().optional(),
};

const contextApplyCompactionSchema = z.union([
  z.object({
    ...contextCompactionBaseShape,
    summary: z.string(),
    compactedCount: z.number(),
    contextSummary: z.string().optional(),
  }),
  z.object({
    ...contextCompactionBaseShape,
    contextSummary: z.string(),
    compactedCount: z.number(),
    summary: z.string().optional(),
  }),
  z.object({
    ...contextCompactionBaseShape,
    summary: contextMessageSchema,
    count: z.number(),
    compactedCount: z.number().optional(),
  }),
]);

export type ContextApplyCompactionPayload = z.infer<typeof contextApplyCompactionSchema>;

export class ContextApplyCompaction extends AgentEvent2<ContextApplyCompactionPayload> {
  static override readonly type = 'context.apply_compaction';
  static override readonly durable = true;
  static override readonly schema = contextApplyCompactionSchema;
}

const contextUndoSchema = z.object({
  agentId: z.string(),
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export class ContextUndo extends AgentEvent2<z.infer<typeof contextUndoSchema>> {
  static override readonly type = 'context.undo';
  static override readonly durable = true;
  static override readonly schema = contextUndoSchema;
}
export interface ContextUndo {
  readonly agentId: string;
  readonly count: number;
}

export interface ContextSplicedPayload {
  readonly agentId: string;
  start: number;
  deleteCount: number;
  messages: readonly ContextMessage[];
  tokens?: number;
}

export class ContextSpliced extends AgentEvent2<ContextSplicedPayload> {
  static override readonly type = 'context.spliced';
  static override readonly observable = true;
}
export interface ContextSpliced extends ContextSplicedPayload {}
