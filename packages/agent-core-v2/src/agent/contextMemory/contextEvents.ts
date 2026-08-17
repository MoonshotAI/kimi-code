/**
 * `contextMemory` domain — the durable `context.*` Event2 classes and the
 * observable `context.spliced` fact.
 *
 * The five durable classes are the wire-protocol 1.4 record vocabulary for
 * the per-agent conversation history; their `serialize()` output is the
 * on-disk record (flat payload, epoch-ms `time`), so v1- and v2-written
 * sessions reduce identically and replay stays silent. `ContextSpliced` is
 * the live-only observable counterpart broadcast after every splice-shaped
 * mutation (`clear` / `applyCompaction` / `undo` / verified cross-model
 * trailing removal). Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';

import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

const contextMessageSchema = z.custom<ContextMessage>();
const loopRecordedEventSchema = z.custom<LoopRecordedEvent>();

const contextAppendMessageSchema = z.object({ message: contextMessageSchema });

export class ContextAppendMessage extends Event2<z.infer<typeof contextAppendMessageSchema>> {
  static override readonly type = 'context.append_message';
  static override readonly durable = true;
  static override readonly schema = contextAppendMessageSchema;
}
export interface ContextAppendMessage extends z.infer<typeof contextAppendMessageSchema> {}

const contextAppendLoopEventSchema = z.object({ event: loopRecordedEventSchema });

export class ContextAppendLoopEvent extends Event2<
  z.infer<typeof contextAppendLoopEventSchema>
> {
  static override readonly type = 'context.append_loop_event';
  static override readonly durable = true;
  static override readonly schema = contextAppendLoopEventSchema;
}
export interface ContextAppendLoopEvent
  extends z.infer<typeof contextAppendLoopEventSchema> {}

const contextClearSchema = z.object({});

export class ContextClear extends Event2<z.infer<typeof contextClearSchema>> {
  static override readonly type = 'context.clear';
  static override readonly durable = true;
  static override readonly schema = contextClearSchema;
}
export interface ContextClear extends z.infer<typeof contextClearSchema> {}

const contextCompactionBaseShape = {
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

export class ContextApplyCompaction extends Event2<ContextApplyCompactionPayload> {
  static override readonly type = 'context.apply_compaction';
  static override readonly durable = true;
  static override readonly schema = contextApplyCompactionSchema;
}

const contextUndoSchema = z.object({
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export class ContextUndo extends Event2<z.infer<typeof contextUndoSchema>> {
  static override readonly type = 'context.undo';
  static override readonly durable = true;
  static override readonly schema = contextUndoSchema;
}
export interface ContextUndo extends z.infer<typeof contextUndoSchema> {}

export interface ContextSplicedPayload {
  start: number;
  deleteCount: number;
  messages: readonly ContextMessage[];
  tokens?: number;
}

export class ContextSpliced extends Event2<ContextSplicedPayload> {
  static override readonly type = 'context.spliced';
  static override readonly observable = true;
}
export interface ContextSpliced extends ContextSplicedPayload {}
