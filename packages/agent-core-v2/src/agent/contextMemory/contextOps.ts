/**
 * Exposes the bounded context wire model, its persisted operations, and blob
 * transforms for live dispatch and replay.
 */

import { z } from 'zod';

import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart } from '#/kosong/contract/message';
import { defineModel, type PartsTransformer } from '#/wire/model';
import type { WireRecord } from '#/wire/record';

import {
  buildContextCompactionShape,
  type ContextCompactionShapeInput,
} from './compactionHandoff';
import {
  computeUndoCut,
  isFullyUndoable,
  isValidUndoCount,
} from './conversationTime';
import {
  foldAppendMessage,
  foldLoopEvent,
  settleModelOpenStep,
  type LoopRecordedEvent,
} from './loopEventFold';
import {
  EMPTY_FOLD,
  freezeContextState,
  type ContextMessage,
  type ContextState,
} from './types';

async function dehydrateMessages(
  messages: readonly ContextMessage[],
  transform: PartsTransformer,
): Promise<{ changed: boolean; result: ContextMessage[] }> {
  let changed = false;
  const result: ContextMessage[] = [];
  for (const msg of messages) {
    const parts = await transform(msg.content);
    if (parts !== msg.content) {
      changed = true;
      result.push({ ...msg, content: [...parts] as ContentPart[] });
    } else {
      result.push(msg);
    }
  }
  return { changed, result };
}

async function dehydrateRecord(
  record: WireRecord,
  transform: PartsTransformer,
): Promise<WireRecord> {
  if (record.type === 'context.append_message') {
    const message = record['message'] as ContextMessage | undefined;
    if (message === undefined) return record;
    const parts = await transform(message.content);
    if (parts === message.content) return record;
    return { ...record, message: { ...message, content: [...parts] } };
  }
  if (record.type === 'context.append_loop_event') {
    const event = record['event'] as LoopRecordedEvent | undefined;
    if (event === undefined) return record;
    switch (event.type) {
      case 'content.part': {
        const parts = await transform([event.part]);
        if (parts[0] === event.part) return record;
        return { ...record, event: { ...event, part: parts[0] } };
      }
      case 'tool.result': {
        const output = event.result.output;
        if (!Array.isArray(output)) return record;
        const parts = await transform(output);
        if (parts === output) return record;
        return { ...record, event: { ...event, result: { ...event.result, output: [...parts] } } };
      }
      case 'step.begin':
      case 'step.end':
      case 'tool.call':
        return record;
      default: {
        const exhaustive: never = event;
        void exhaustive;
        return record;
      }
    }
  }
  return record;
}

export const ContextModel = defineModel<ContextState>(
  'contextMemory',
  () => freezeContextState({ messages: [], fold: EMPTY_FOLD }),
  {
    blobs: {
      dehydrate: dehydrateRecord,
      rehydrate: async (state, transform) => {
        const messages = await dehydrateMessages(state.messages, transform);
        const deferred = await dehydrateMessages(state.fold.deferredEntries, transform);
        if (!messages.changed && !deferred.changed) return state;
        return freezeContextState({
          messages: messages.result,
          fold: deferred.changed ? { ...state.fold, deferredEntries: deferred.result } : state.fold,
        });
      },
    },
    reducers: {
      'swarm_mode.exit': popSwarmModeReminder,
    },
  },
);

function popSwarmModeReminder(state: ContextState, _payload: unknown): ContextState {
  const last = state.messages.at(-1);
  if (last === undefined) return state;
  const origin = last.origin;
  if (origin?.kind !== 'injection' || origin.variant !== 'swarm_mode') return state;
  return freezeContextState({ messages: state.messages.slice(0, -1), fold: EMPTY_FOLD });
}

declare module '#/wire/types' {
  interface PersistedOpMap {
    'context.append_message': typeof contextAppendMessage;
    'context.append_loop_event': typeof contextAppendLoopEvent;
    'context.clear': typeof contextClear;
    'context.apply_compaction': typeof contextApplyCompaction;
    'context.undo': typeof contextUndo;
  }
}

const contextMessageSchema = z.custom<ContextMessage>();
const loopRecordedEventSchema = z.custom<LoopRecordedEvent>();

export const contextAppendMessage = ContextModel.defineOp('context.append_message', {
  schema: z.object({ message: contextMessageSchema }),
  apply: (state, p) => freezeContextState(foldAppendMessage(state, p.message)),
});

export const contextAppendLoopEvent = ContextModel.defineOp('context.append_loop_event', {
  schema: z.object({ event: loopRecordedEventSchema }),
  apply: (state, p) => freezeContextState(foldLoopEvent(state, p.event)),
});

export const contextClear = ContextModel.defineOp('context.clear', {
  schema: z.object({}),
  apply: (state) => {
    const { fold } = state;
    const pristine =
      fold.openStepUuid === undefined &&
      fold.pendingToolCallIds.length === 0 &&
      fold.deferredEntries.length === 0;
    if (state.messages.length === 0 && pristine) return state;
    return freezeContextState({ messages: [], fold: EMPTY_FOLD });
  },
});

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

type ContextCompactionPayload = z.infer<typeof contextApplyCompactionSchema>;

export const contextApplyCompaction = ContextModel.defineOp('context.apply_compaction', {
  schema: contextApplyCompactionSchema,
  apply: (state, p) => {
    const settled = settleModelOpenStep(state);
    const result = buildContextCompactionShape(
      settled.messages,
      readContextCompactionShapeInput(p),
    );
    return freezeContextState({ messages: [...result.messages], fold: EMPTY_FOLD });
  },
});

interface UnknownRecord {
  readonly [key: string]: unknown;
}

type ContextCompactionRecord = ContextCompactionPayload | UnknownRecord;

function readContextCompactionShapeInput(
  record: ContextCompactionRecord,
): ContextCompactionShapeInput {
  const fields = record as UnknownRecord;
  const keptUserMessageCount = readOptionalNumber(fields, 'keptUserMessageCount');
  return {
    summary: readContextCompactionRawSummary(fields),
    legacySummaryMessage: readLegacySummaryMessage(fields),
    contextSummary: readOptionalString(fields, 'contextSummary'),
    compactedCount: readContextCompactedCount(fields),
    tokensBefore: readOptionalNumber(fields, 'tokensBefore') ?? 0,
    tokensAfter: readOptionalNumber(fields, 'tokensAfter'),
    summaryOutputTokens: readOptionalNumber(fields, 'summaryOutputTokens'),
    keptUserMessageCount,
    keptHeadUserMessageCount: readOptionalNumber(fields, 'keptHeadUserMessageCount'),
    droppedCount: readOptionalNumber(fields, 'droppedCount'),
    legacyTail: readOptionalBoolean(fields, 'legacyTail') ?? keptUserMessageCount === undefined,
  };
}

function readContextCompactedCount(record: ContextCompactionRecord): number {
  const fields = record as UnknownRecord;
  const compactedCount = fields['compactedCount'];
  if (typeof compactedCount === 'number') return compactedCount;
  const legacyCount = fields['count'];
  if (typeof legacyCount === 'number') return legacyCount;
  throw new Error2(
    ErrorCodes.STORAGE_DECODE_FAILED,
    'Invalid context.apply_compaction record: missing compactedCount',
    {
      details: {
        recordKeys: Object.keys(record),
        compactedCountType: typeof compactedCount,
        countType: typeof legacyCount,
      },
    },
  );
}

function readContextCompactionRawSummary(record: UnknownRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessage(summary)) {
    return textOf(summary);
  }
  throw new Error2(
    ErrorCodes.STORAGE_DECODE_FAILED,
    'Invalid context.apply_compaction record: missing summary',
    {
      details: {
        recordKeys: Object.keys(record),
        summaryType: typeof summary,
        contextSummaryType: typeof contextSummary,
      },
    },
  );
}

function readLegacySummaryMessage(record: UnknownRecord): ContextMessage | undefined {
  const summary = record['summary'];
  return isContextMessage(summary) ? summary : undefined;
}

function readOptionalNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readOptionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readOptionalBoolean(record: UnknownRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function textOf(message: ContextMessage): string {
  let text = '';
  for (const part of message.content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function isContextMessage(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

export type UndoUnavailableReason =
  | 'empty'
  | 'compaction_boundary'
  | 'insufficient'
  | 'checkpoint_lost';

export type UndoPrecheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: UndoUnavailableReason;
      readonly requested: number;
      readonly undoable: number;
    };

export function precheckUndo(history: readonly ContextMessage[], count: number): UndoPrecheck {
  const cut = computeUndoCut(history, count);
  if (isFullyUndoable(cut, count)) return { ok: true };
  const reason: UndoUnavailableReason = cut.stoppedAtCompaction
    ? 'compaction_boundary'
    : cut.removedCount === 0
      ? 'empty'
      : 'insufficient';
  return { ok: false, reason, requested: count, undoable: cut.removedCount };
}

export function formatUndoUnavailableMessage(
  precheck: Extract<UndoPrecheck, { ok: false }>,
): string {
  switch (precheck.reason) {
    case 'empty':
      return 'Nothing to undo: no user message to undo';
    case 'compaction_boundary':
      return 'Nothing to undo: would cross a compaction boundary';
    case 'insufficient':
      return `Nothing to undo: only ${precheck.undoable} of ${precheck.requested} requested turn(s) available`;
    case 'checkpoint_lost':
      return 'Nothing to undo: conversation state checkpoints are incomplete';
  }
}

export const contextUndo = ContextModel.defineOp('context.undo', {
  schema: z.object({
    count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  apply: (state, p) => {
    if (!isValidUndoCount(p.count) || state.messages.length === 0) return state;
    const cut = computeUndoCut(state.messages, p.count);
    if (!isFullyUndoable(cut, p.count)) return state;
    return freezeContextState({
      messages: state.messages.slice(0, cut.cutIndex),
      fold: EMPTY_FOLD,
    });
  },
});
