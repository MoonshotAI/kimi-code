import { ErrorCodes, Error2 } from '#/errors';

import {
  buildContextCompactionShape,
  createCompactionSummaryMessage,
  type ContextCompactionShapeInput,
} from './compactionHandoff';
import { type ContextApplyCompactionPayload } from './contextEvents';
import { isPromptOwnedInjection, isUndoAnchor } from './conversationTime';
import { resetFold } from './loopEventFold';
import type { ContextMessage } from './types';

export function popSwarmModeReminder(state: ContextMessage[]): ContextMessage[] {
  const last = state.at(-1);
  if (last?.origin?.kind !== 'injection' || last.origin.variant !== 'swarm_mode') return state;
  return resetFold(state.slice(0, -1)) as ContextMessage[];
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

type ContextCompactionRecord = ContextApplyCompactionPayload | UnknownRecord;

export function applyContextCompactionRecord(
  state: readonly ContextMessage[],
  record: ContextCompactionRecord,
): ContextMessage[] {
  const result = buildContextCompactionShape(state, readContextCompactionShapeInput(record));
  return resetFold([...result.messages]) as ContextMessage[];
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

export function readContextCompactionSummary(record: ContextCompactionRecord): ContextMessage {
  const fields = record as UnknownRecord;
  const contextSummary = fields['contextSummary'];
  if (typeof contextSummary === 'string') return createCompactionSummaryMessage(contextSummary);
  const summary = fields['summary'];
  if (typeof summary === 'string') return createCompactionSummaryMessage(summary);
  if (isContextMessage(summary)) return summary;
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

export interface UndoCut {
  readonly cutIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

export function computeUndoCut(state: readonly ContextMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const message = state[i];
    if (message === undefined || message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isUndoAnchor(message)) {
      remaining--;
      removedCount++;
      cutIndex = i;
      while (
        cutIndex > 0 &&
        isPromptOwnedInjection(state[cutIndex - 1]!, message)
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
