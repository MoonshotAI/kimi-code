/**
 * Projects context wire records into the full display transcript while
 * reporting the suffix currently folded into the bounded model context.
 */

import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  compactedWindowMessageCount,
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

  const applyReducedState = (next: ContextState<TranscriptEntry>): void => {
    foldedLength += next.messages.length - state.messages.length;
    state = next;
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    const cut = computeUndoCutFrom(state.messages, count, entryAdapter.messageOf, clearFloor);
    if (!isFullyUndoable(cut, count)) return;
    const entries = state.messages;
    const { keptTail, removedEntryCount } = removeUndoOwnedEntries(entries, cut.cutIndex);
    foldedLength = Math.max(0, foldedLength - removedEntryCount);
    state = { messages: [...entries.slice(0, cut.cutIndex), ...keptTail], fold: EMPTY_FOLD };
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message': {
        applyReducedState(
          appendMessageTo(state, {
            message: record['message'] as ContextMessage,
            time: record.time,
          }),
        );
        return;
      }
      case 'context.append_loop_event': {
        const time = record.time;
        applyReducedState(
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
        state = settleOpenStep(
          state,
          entryAdapter,
          (message): TranscriptEntry => ({ message, time: record.time }),
        );
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

function removeUndoOwnedEntries(
  entries: readonly TranscriptEntry[],
  cutIndex: number,
): { readonly keptTail: TranscriptEntry[]; readonly removedEntryCount: number } {
  const removedPromptIds = new Set<string>();
  for (let i = cutIndex; i < entries.length; i++) {
    const message = entries[i]!.message;
    if (message.id !== undefined && isUndoAnchor(message)) removedPromptIds.add(message.id);
  }
  let removedEntryCount = 0;
  const keptTail: TranscriptEntry[] = [];
  for (let i = cutIndex; i < entries.length; i++) {
    const entry = entries[i]!;
    const origin = entry.message.origin;
    if (
      origin?.kind === 'injection' &&
      (origin.ownerPromptId === undefined || !removedPromptIds.has(origin.ownerPromptId))
    ) {
      keptTail.push(entry);
    } else {
      removedEntryCount++;
    }
  }
  return { keptTail, removedEntryCount };
}

function recoverFoldedLength(
  record: WireRecord,
  transcript: readonly TranscriptEntry[],
  clearFloor: number,
  foldedLength: number,
): number {
  const resultCount = compactedWindowMessageCount(
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
