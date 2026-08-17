/**
 * `contextMemory` domain — rebuilds display history from the wire journal.
 *
 * Supplies transcript consumers with full pre-compaction history and folded
 * context length while preserving undo/clear semantics. Scope-agnostic.
 *
 * Loop events and plain appends are reduced by the shared fold kernel
 * (`loopEventFold.ts`) over time-stamped entries, so the display view can
 * never drift from the live/replay fold; undo applies the shared cut
 * decision from `conversationTime` (a blocked undo — compaction boundary,
 * insufficient anchors, clear floor — is a no-op here exactly as in the
 * model Op); and the post-compaction `foldedLength` comes from
 * `compactionHandoff`'s result-count mirror rather than a local
 * re-derivation of the compaction shape. What stays local is the display
 * bookkeeping the shared pieces do not own — per-entry record times,
 * `clearFloor`, and `foldedLength` — plus the transcript-specific
 * application of those decisions: undo splices the tail but keeps orphan
 * injections (prompt-owned ones leave with their prompt), clear keeps
 * entries and moves the floor, and compaction settles any frame a failed
 * attempt left open, then appends the summary marker while keeping the
 * folded prefix.
 */

import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  compactionResultMessageCount,
  selectRecentUserMessages,
} from './compactionHandoff';
import { computeUndoCutFrom, isFullyUndoable, isUndoAnchor } from './conversationTime';
import {
  appendMessageTo,
  applyLoopEventTo,
  settleOpenStep,
  type FoldEntryAdapter,
  type LoopRecordedEvent,
} from './loopEventFold';
import { EMPTY_FOLD, type ContextMessage, type ContextState } from './types';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
}

interface TranscriptEntry {
  readonly message: ContextMessage;
  readonly time?: number;
}

const entryAdapter: FoldEntryAdapter<TranscriptEntry> = {
  messageOf: (entry) => entry.message,
  withMessage: (entry, message) => ({ ...entry, message }),
};

export function reduceContextTranscript(records: Iterable<WireRecord>): ContextTranscript {
  const reducer = createContextTranscriptReducer();
  for (const record of records) reducer.add(record);
  return reducer.result();
}

export function createContextTranscriptReducer(): ContextTranscriptReducer {
  let state: ContextState<TranscriptEntry> = { messages: [], fold: EMPTY_FOLD };
  let foldedLength = 0;
  let clearFloor = 0;

  const applyKernel = (next: ContextState<TranscriptEntry>): void => {
    foldedLength += next.messages.length - state.messages.length;
    state = next;
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    const cut = computeUndoCutFrom(state.messages, count, entryAdapter.messageOf, clearFloor);
    if (!isFullyUndoable(cut, count)) return;
    const entries = state.messages;
    const removedPromptIds = new Set<string>();
    for (let i = cut.cutIndex; i < entries.length; i++) {
      const message = entries[i]!.message;
      if (message.id !== undefined && isUndoAnchor(message)) removedPromptIds.add(message.id);
    }
    let removed = 0;
    const kept: TranscriptEntry[] = [];
    for (let i = cut.cutIndex; i < entries.length; i++) {
      const entry = entries[i]!;
      const origin = entry.message.origin;
      if (
        origin?.kind === 'injection' &&
        (origin.ownerPromptId === undefined || !removedPromptIds.has(origin.ownerPromptId))
      ) {
        kept.push(entry);
      } else {
        removed++;
      }
    }
    foldedLength = Math.max(0, foldedLength - removed);
    state = { messages: [...entries.slice(0, cut.cutIndex), ...kept], fold: EMPTY_FOLD };
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message': {
        applyKernel(
          appendMessageTo(state, {
            message: record['message'] as ContextMessage,
            time: record.time,
          }),
        );
        return;
      }
      case 'context.append_loop_event': {
        const time = record.time;
        applyKernel(
          applyLoopEventTo(
            state,
            record['event'] as LoopRecordedEvent,
            entryAdapter,
            (message): TranscriptEntry => ({ message, time }),
          ),
        );
        return;
      }
      case 'context.apply_compaction': {
        // Mirror the model fold, which settles any frame left open by a
        // failed attempt before appending the marker (an overflow compaction
        // lands mid-fold; see `contextOps`). Settling at the same record keeps
        // the length bookkeeping aligned; `recoverFoldedLength` recomputes the
        // absolute value right after either way.
        const settled = settleOpenStep(
          state,
          entryAdapter,
          (message): TranscriptEntry => ({ message, time: record.time }),
        );
        const summary: ContextMessage = {
          role: 'user',
          content: [{ type: 'text', text: readCompactionSummaryText(record) }],
          toolCalls: [],
          origin: { kind: 'compaction_summary' },
        };
        state = {
          messages: [...settled.messages, { message: summary, time: record.time }],
          fold: EMPTY_FOLD,
        };
        foldedLength = recoverFoldedLength(record, state.messages, clearFloor, foldedLength);
        return;
      }
      case 'context.undo':
        applyUndo(record['count'] as number);
        return;
      case 'context.clear':
        clearFloor = state.messages.length;
        foldedLength = 0;
        state = { messages: state.messages, fold: EMPTY_FOLD };
        return;
      default:
        return;
    }
  };

  return {
    add,
    result: () => ({
      entries: state.messages.map((entry) => entry.message),
      times: state.messages.map((entry) => entry.time),
      foldedLength,
    }),
  };
}

function recoverFoldedLength(
  record: WireRecord,
  transcript: readonly TranscriptEntry[],
  clearFloor: number,
  foldedLength: number,
): number {
  const resultCount = compactionResultMessageCount(
    readNumber(record, 'keptUserMessageCount'),
    readNumber(record, 'keptHeadUserMessageCount'),
  );
  if (resultCount !== undefined) return resultCount;
  const compactedCount = readNumber(record, 'compactedCount');
  if (compactedCount !== undefined && compactedCount < foldedLength) {
    return 1 + (foldedLength - compactedCount);
  }
  const keptUserMessages = selectRecentUserMessages(
    collectCompactableUserMessages(transcript.slice(clearFloor).map((entry) => entry.message)),
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  );
  return keptUserMessages.length + 1;
}

function readCompactionSummaryText(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessageLike(summary)) return textOfParts(summary.content);
  return '';
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function textOfParts(content: ContextMessage['content']): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}
