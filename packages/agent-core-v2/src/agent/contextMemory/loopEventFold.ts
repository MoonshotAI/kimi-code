/**
 * `contextMemory` loop-event fold — the single kernel that reduces
 * `context.append_loop_event` / `context.append_message` records into folded
 * conversation entries.
 *
 * The agent loop streams a turn as `context.append_loop_event` records
 * (`step.begin` / `content.part` / `tool.call` / `tool.result` / `step.end`)
 * and never writes a folded assistant message, keeping the on-disk shape
 * byte-compatible with v1. This fold turns them into assistant / tool
 * messages — at live dispatch time and again when `WireService.restore`
 * restores an Agent. Without it, restore would skip those records (no Op is
 * registered for the type) and the restored `ContextModel` — and every
 * consumer built on it — would show only the user prompts.
 *
 * Semantics mirror the v1 fold exactly:
 *   - `step.begin`  → open an assistant message (`partial: true`); first settle
 *                     the step left open by a failed attempt
 *   - `content.part`→ append to the open assistant's content
 *   - `tool.call`   → append to the open assistant's `toolCalls`, mark pending
 *   - `tool.result` → push a `tool` message (with the v1 output
 *                     wrapping), clear its pending id
 *   - `step.end`    → settle the assistant
 * "Settle" closes any tool exchange left open (interrupted result messages),
 * then drops the partial assistant when nothing sendable was recorded (no
 * tool calls; every content part vacuous — an output-free assistant only
 * trips provider message validation) and seals it (`partial: undefined`)
 * when it carries output. v1 never produced
 * `step.begin` without `step.end` (its retries stayed inside one request), so
 * the drop/seal rule is the v2 extension that makes loop-level retries — a
 * retried attempt is its own `step.begin` — replay to the same history the
 * live loop folded.
 * A `context.append_message` reduced while a tool exchange is still open is
 * deferred and flushed once the exchange closes, so strict-provider
 * assistant↔tool adjacency is preserved.
 * Events tagged with a step uuid that is not the open one (a late event of an
 * attempt whose `step.begin` was already settled) are dropped, and a
 * `step.end` only settles the step it names.
 *
 * The fold is stateful across records within one replay; the cursor
 * (`openStepUuid` / `pending` / `deferred`) is part of the state's `fold`
 * field, so live dispatch and replay share one pure transition, and every
 * wholesale state replacement (undo / clear / compaction) resets the cursor
 * structurally by returning `EMPTY_FOLD`.
 *
 * The kernel is generic over the entry type: it reduces one `ContextState<E>`
 * — the entries folded so far plus the fold cursor — into the next, and a
 * `FoldEntryAdapter<E>` is how the kernel reads and rewrites the message an
 * entry carries. The wire model folds bare `ContextMessage`s
 * (`foldAppendMessage` / `foldLoopEvent` / `settleModelOpenStep`
 * specializations below), while the display transcript (`contextTranscript.ts`)
 * folds time-stamped entries — one reduction semantics, two read models.
 * `settleOpenStep` stands alone for closing an open frame outside the event
 * stream: the model applies it (via `settleModelOpenStep`) when a compaction
 * lands mid-fold — the marker only ever lands on a settled frame, so the log
 * stays append-only across markers — and the transcript applies it at the
 * same record to mirror that.
 */

import type { FinishReason } from '#/kosong/contract/provider';
import { createToolMessage, type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';

import type { ContextMessage, ContextState } from './types';
import { isVacuousContentPart } from './vacuousContent';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export type LoopRecordedEvent =
  | {
      readonly type: 'step.begin';
      readonly uuid: string;
      readonly turnId?: string;
      readonly step?: number;
    }
  | {
      readonly type: 'step.end';
      readonly uuid: string;
      readonly turnId?: string;
      readonly step?: number;
      readonly finishReason?: string;
      readonly usage?: TokenUsage;
      readonly llmFirstTokenLatencyMs?: number;
      readonly llmStreamDurationMs?: number;
      readonly llmRequestBuildMs?: number;
      readonly llmServerFirstTokenMs?: number;
      readonly llmServerDecodeMs?: number;
      readonly llmClientConsumeMs?: number;
      readonly messageId?: string;
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
    }
  | {
      readonly type: 'content.part';
      readonly stepUuid: string;
      readonly part: ContentPart;
      readonly uuid?: string;
      readonly turnId?: string;
      readonly step?: number;
    }
  | {
      readonly type: 'tool.call';
      readonly stepUuid: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly args?: unknown;
      readonly extras?: Record<string, unknown>;
      readonly uuid?: string;
      readonly turnId?: string;
      readonly step?: number;
    }
  | {
      readonly type: 'tool.result';
      readonly toolCallId: string;
      readonly result: {
        readonly output: string | readonly ContentPart[];
        readonly isError?: boolean;
        readonly note?: string;
      };
      readonly parentUuid?: string;
    };

export interface FoldEntryAdapter<E> {
  readonly messageOf: (entry: E) => ContextMessage;
  readonly withMessage: (entry: E, message: ContextMessage) => E;
}

const messageAdapter: FoldEntryAdapter<ContextMessage> = {
  messageOf: (entry) => entry,
  withMessage: (_entry, message) => message,
};

export function foldAppendMessage(state: ContextState, message: ContextMessage): ContextState {
  return appendMessageTo(state, stripCompactionMarker(message));
}

/** `CompactionMeta` is fold-internal bookkeeping produced only by the
 *  `context.apply_compaction` Op; an `append_message` record carrying it (a
 *  fork copying the visible window, an external writer) must not mint a real
 *  marker — strip it so the log can only gain markers through the Op. */
function stripCompactionMarker(message: ContextMessage): ContextMessage {
  if (message.compaction === undefined) return message;
  const { compaction: _meta, ...stripped } = message;
  void _meta;
  return stripped;
}

export function foldLoopEvent(state: ContextState, event: LoopRecordedEvent): ContextState {
  return applyLoopEventTo(state, event, messageAdapter, (message) => message);
}

export function settleModelOpenStep(state: ContextState): ContextState {
  return settleOpenStep(state, messageAdapter, (message) => message);
}

export function appendMessageTo<E>(state: ContextState<E>, entry: E): ContextState<E> {
  const { fold } = state;
  if (fold.pending.length > 0) {
    return { ...state, fold: { ...fold, deferred: [...fold.deferred, entry] } };
  }
  return { ...state, messages: [...state.messages, entry] };
}

export function applyLoopEventTo<E>(
  state: ContextState<E>,
  event: LoopRecordedEvent,
  adapter: FoldEntryAdapter<E>,
  makeEntry: (message: ContextMessage) => E,
): ContextState<E> {
  const { fold } = state;
  switch (event.type) {
    case 'step.begin': {
      const settled = settleOpenStep(state, adapter, makeEntry);
      const assistant: ContextMessage = {
        role: 'assistant',
        content: [],
        toolCalls: [],
        partial: true,
      };
      return {
        messages: [...settled.messages, makeEntry(assistant)],
        fold: { ...settled.fold, openStepUuid: event.uuid },
      };
    }
    case 'step.end': {
      if (fold.openStepUuid !== event.uuid) return flushDeferred(state);
      const settled = settleOpenStep(
        { ...state, fold: { ...fold, openStepUuid: undefined } },
        adapter,
        makeEntry,
      );
      return flushDeferred(settled);
    }
    case 'content.part': {
      if (fold.openStepUuid !== event.stepUuid) return state;
      return updateOpenAssistant(state, adapter, (message) => ({
        ...message,
        content: [...message.content, event.part],
      }));
    }
    case 'tool.call': {
      if (fold.openStepUuid !== event.stepUuid) return state;
      const call: ToolCall = {
        type: 'function',
        id: event.toolCallId,
        name: event.name,
        arguments: event.args === undefined ? null : JSON.stringify(event.args),
        ...(event.extras !== undefined ? { extras: event.extras } : {}),
      };
      const withPending: ContextState<E> = {
        ...state,
        fold: { ...fold, pending: [...fold.pending, event.toolCallId] },
      };
      return updateOpenAssistant(withPending, adapter, (message) => ({
        ...message,
        toolCalls: [...message.toolCalls, call],
      }));
    }
    case 'tool.result': {
      if (!fold.pending.includes(event.toolCallId)) return state;
      const output = event.result.output;
      const toolMessage: ContextMessage = {
        ...createToolMessage(event.toolCallId, typeof output === 'string' ? output : [...output]),
        isError: event.result.isError,
        note: event.result.note,
      };
      const next: ContextState<E> = {
        messages: [...state.messages, makeEntry(toolMessage)],
        fold: { ...fold, pending: fold.pending.filter((id) => id !== event.toolCallId) },
      };
      return flushDeferred(next);
    }
    default:
      return state;
  }
}

function updateOpenAssistant<E>(
  state: ContextState<E>,
  adapter: FoldEntryAdapter<E>,
  update: (message: ContextMessage) => ContextMessage,
): ContextState<E> {
  const index = findOpenAssistantIndex(state, adapter);
  if (index === -1) return state;
  const messages = state.messages.slice();
  messages[index] = adapter.withMessage(messages[index]!, update(adapter.messageOf(messages[index]!)));
  return { ...state, messages };
}

export function settleOpenStep<E>(
  state: ContextState<E>,
  adapter: FoldEntryAdapter<E>,
  makeEntry: (message: ContextMessage) => E,
): ContextState<E> {
  const closed = closePending(state, makeEntry);
  const index = findOpenAssistantIndex(closed, adapter);
  if (index === -1) return closed;
  const open = adapter.messageOf(closed.messages[index]!);
  if (open.toolCalls.length === 0 && open.content.every(isVacuousContentPart)) {
    return {
      ...closed,
      messages: [...closed.messages.slice(0, index), ...closed.messages.slice(index + 1)],
    };
  }
  const messages = closed.messages.slice();
  messages[index] = adapter.withMessage(messages[index]!, { ...open, partial: undefined });
  return { ...closed, messages };
}

function findOpenAssistantIndex<E>(state: ContextState<E>, adapter: FoldEntryAdapter<E>): number {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (adapter.messageOf(state.messages[i]!).partial === true) return i;
  }
  return -1;
}

function closePending<E>(
  state: ContextState<E>,
  makeEntry: (message: ContextMessage) => E,
): ContextState<E> {
  const { fold } = state;
  if (fold.pending.length === 0) return state;
  const messages = state.messages.slice();
  for (const toolCallId of fold.pending) {
    messages.push(makeEntry(interruptedToolMessage(toolCallId)));
  }
  return flushDeferred({ ...state, messages, fold: { ...fold, pending: [] } });
}

function flushDeferred<E>(state: ContextState<E>): ContextState<E> {
  const { fold } = state;
  if (fold.pending.length > 0 || fold.deferred.length === 0) return state;
  return {
    messages: [...state.messages, ...fold.deferred],
    fold: { ...fold, deferred: [] },
  };
}

function interruptedToolMessage(toolCallId: string): ContextMessage {
  return {
    ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    isError: true,
  };
}
