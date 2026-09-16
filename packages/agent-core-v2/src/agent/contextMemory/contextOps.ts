import { z } from 'zod';

import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart } from '#human/llm/message';
import {
  isAssistantEntry,
  isSystemEntry,
  isUserEntry,
  type HistoryMessage,
} from '#human/agent/turn';
import { defineState } from '#/state/state';
import type { PartsTransformer } from '#/wire/record';
import type { WireRecord } from '#/wire/record';

import {
  buildContextCompactionShape,
  createCompactionSummaryMessage,
  type ContextCompactionShapeInput,
} from './compactionHandoff';
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  type ContextApplyCompactionPayload,
} from './contextEvents';
import { isPromptOwnedInjection, isUndoAnchor } from './conversationTime';
import {
  foldAppendMessage,
  foldLoopEvent,
  normalizeReplayedEntry,
  resetFold,
  type LoopRecordedEvent,
} from './loopEventFold';

async function dehydrateMessages(
  messages: readonly HistoryMessage[],
  transform: PartsTransformer,
): Promise<{ changed: boolean; result: HistoryMessage[] }> {
  let changed = false;
  const result: HistoryMessage[] = [];
  for (const entry of messages) {
    const parts = await transform(entry.message.content);
    if (parts !== entry.message.content) {
      changed = true;
      result.push(withMessageContent(entry, [...parts] as ContentPart[]));
    } else {
      result.push(entry);
    }
  }
  return { changed, result };
}

function withMessageContent(entry: HistoryMessage, content: ContentPart[]): HistoryMessage {
  if (isSystemEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  if (isUserEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  if (isAssistantEntry(entry)) return { ...entry, message: { ...entry.message, content } };
  return { ...entry, message: { ...entry.message, content } };
}

async function dehydrateRecord(
  record: WireRecord,
  transform: PartsTransformer,
): Promise<WireRecord> {
  if (record.type === 'context.append_message') {
    const raw = record['message'] as
      | { readonly role?: unknown; readonly content?: readonly ContentPart[]; readonly message?: { readonly content?: readonly ContentPart[] } }
      | undefined;
    if (raw === undefined || raw === null) return record;
    if (typeof raw.role === 'string') {
      const parts = await transform([...(raw.content ?? [])]);
      if (parts === (raw.content ?? [])) return record;
      return { ...record, message: { ...raw, content: [...parts] } };
    }
    const inner = raw.message;
    if (inner === undefined) return record;
    const parts = await transform([...(inner.content ?? [])]);
    if (parts === (inner.content ?? [])) return record;
    return { ...record, message: { ...raw, message: { ...inner, content: [...parts] } } };
  }
  if (record.type === 'context.append_loop_event') {
    const event = record['event'] as LoopRecordedEvent | undefined;
    if (event === undefined) return record;
    if (event.type === 'content.part') {
      const parts = await transform([event.part]);
      if (parts[0] === event.part) return record;
      return { ...record, event: { ...event, part: parts[0] } };
    }
    if (event.type === 'tool.result') {
      const output = event.result.output;
      if (!Array.isArray(output)) return record;
      const parts = await transform(output);
      if (parts === output) return record;
      return { ...record, event: { ...event, result: { ...event.result, output: [...parts] } } };
    }
    return record;
  }
  return record;
}

export const contextMemoryKey = defineState('contextMemory', (): HistoryMessage[] => [])
  .replayable({
    schema: z.custom<HistoryMessage[]>(),
    blobs: {
      dehydrate: dehydrateRecord,
      rehydrate: async (state, transform) => {
        const { changed, result } = await dehydrateMessages(state, transform);
        return changed ? result : state;
      },
    },
  })
  .undoable({
    onUndo: (s, count) => {
      if (s.length === 0) return;
      const cut = computeUndoCut(s, count);
      if (!isFullyUndoable(cut, count)) return;
      return resetFold(s.slice(0, cut.cutIndex)) as HistoryMessage[];
    },
  })
  .on(ContextAppendMessage, (s, e) => foldAppendMessage(s, e.message) as HistoryMessage[])
  .on(ContextAppendLoopEvent, (s, e) => foldLoopEvent(s, e.event) as HistoryMessage[])
  .on(ContextClear, (s) => (s.length === 0 ? undefined : (resetFold([]) as HistoryMessage[])))
  .on(ContextApplyCompaction, (s, e) => {
    const result = buildContextCompactionShape(
      s,
      readContextCompactionShapeInput(e as unknown as ContextApplyCompactionPayload),
    );
    return resetFold([...result.messages]) as HistoryMessage[];
  });

export function popSwarmModeReminder(state: HistoryMessage[]): HistoryMessage[] {
  const last = state.at(-1);
  const origin = last !== undefined && isUserEntry(last) ? last.meta?.origin : undefined;
  if (origin?.kind !== 'injection' || origin.variant !== 'swarm_mode') return state;
  return resetFold(state.slice(0, -1)) as HistoryMessage[];
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

type ContextCompactionRecord = ContextApplyCompactionPayload | UnknownRecord;

export function applyContextCompactionRecord(
  state: readonly HistoryMessage[],
  record: ContextCompactionRecord,
): HistoryMessage[] {
  const result = buildContextCompactionShape(state, readContextCompactionShapeInput(record));
  return resetFold([...result.messages]) as HistoryMessage[];
}

export function readContextCompactionShapeInput(
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

export function readContextCompactedCount(record: ContextCompactionRecord): number {
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

export function readContextCompactionSummary(record: ContextCompactionRecord): HistoryMessage {
  const fields = record as UnknownRecord;
  const contextSummary = fields['contextSummary'];
  if (typeof contextSummary === 'string') return createCompactionSummaryMessage(contextSummary);
  const summary = fields['summary'];
  if (typeof summary === 'string') return createCompactionSummaryMessage(summary);
  if (isLegacyFlatMessage(summary)) return normalizeReplayedEntry(summary);
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

function readContextCompactionRawSummary(record: UnknownRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isLegacyFlatMessage(summary)) {
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

function readLegacySummaryMessage(record: UnknownRecord): HistoryMessage | undefined {
  const summary = record['summary'];
  return isLegacyFlatMessage(summary) ? normalizeReplayedEntry(summary) : undefined;
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

function textOf(message: { readonly content: readonly ContentPart[] }): string {
  let text = '';
  for (const part of message.content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function isLegacyFlatMessage(value: unknown): value is { readonly role: string; readonly content: readonly ContentPart[] } {
  if (value === null || typeof value !== 'object') return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

export interface UndoCut {
  readonly cutIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

export function computeUndoCut(state: readonly HistoryMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = state[i];
    if (entry === undefined) continue;
    const origin = entry.meta?.origin;
    if (origin?.kind === 'injection') continue;
    if (origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isUndoAnchor(entry)) {
      remaining--;
      removedCount++;
      cutIndex = i;
      while (
        cutIndex > 0 &&
        isPromptOwnedInjection(state[cutIndex - 1]!, entry)
      ) {
        cutIndex--;
      }
    }
  }
  return { cutIndex, removedCount, stoppedAtCompaction };
}

export function isFullyUndoable(cut: UndoCut, count: number): boolean {
  return cut.cutIndex >= 0 && cut.removedCount >= count;
}

export type UndoUnavailableReason =
  | 'empty'
  | 'compaction_boundary'
  | 'insufficient';

export type UndoPrecheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: UndoUnavailableReason;
      readonly requested: number;
      readonly undoable: number;
    };

export function precheckUndo(history: readonly HistoryMessage[], count: number): UndoPrecheck {
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
  }
}
