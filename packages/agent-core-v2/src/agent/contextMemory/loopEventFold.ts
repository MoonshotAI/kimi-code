/**
 * Folds persisted loop events into conversation messages for both the live
 * bounded context model and the timestamped transcript projection.
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
  return appendMessageTo(state, message);
}

export function foldLoopEvent(state: ContextState, event: LoopRecordedEvent): ContextState {
  return applyLoopEventTo(state, event, messageAdapter, (message) => message);
}

export function settleModelOpenStep(state: ContextState): ContextState {
  return settleOpenStep(state, messageAdapter, (message) => message);
}

export function appendMessageTo<E>(state: ContextState<E>, entry: E): ContextState<E> {
  const { fold } = state;
  if (fold.pendingToolCallIds.length > 0) {
    return { ...state, fold: { ...fold, deferredEntries: [...fold.deferredEntries, entry] } };
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
      const stateAfterPreviousStep = settleOpenStep(state, adapter, makeEntry);
      const assistant: ContextMessage = {
        role: 'assistant',
        content: [],
        toolCalls: [],
        partial: true,
      };
      return {
        messages: [...stateAfterPreviousStep.messages, makeEntry(assistant)],
        fold: { ...stateAfterPreviousStep.fold, openStepUuid: event.uuid },
      };
    }
    case 'step.end': {
      if (fold.openStepUuid !== event.uuid) return flushDeferred(state);
      const stateAfterStepEnd = settleOpenStep(
        { ...state, fold: { ...fold, openStepUuid: undefined } },
        adapter,
        makeEntry,
      );
      return flushDeferred(stateAfterStepEnd);
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
      const stateWithPendingToolCall: ContextState<E> = {
        ...state,
        fold: { ...fold, pendingToolCallIds: [...fold.pendingToolCallIds, event.toolCallId] },
      };
      return updateOpenAssistant(stateWithPendingToolCall, adapter, (message) => ({
        ...message,
        toolCalls: [...message.toolCalls, call],
      }));
    }
    case 'tool.result': {
      if (!fold.pendingToolCallIds.includes(event.toolCallId)) return state;
      const output = event.result.output;
      const toolMessage: ContextMessage = {
        ...createToolMessage(event.toolCallId, typeof output === 'string' ? output : [...output]),
        isError: event.result.isError,
        note: event.result.note,
      };
      const stateWithToolResult: ContextState<E> = {
        messages: [...state.messages, makeEntry(toolMessage)],
        fold: { ...fold, pendingToolCallIds: fold.pendingToolCallIds.filter((id) => id !== event.toolCallId) },
      };
      return flushDeferred(stateWithToolResult);
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
  if (fold.pendingToolCallIds.length === 0) return state;
  const messages = state.messages.slice();
  for (const toolCallId of fold.pendingToolCallIds) {
    messages.push(makeEntry(interruptedToolMessage(toolCallId)));
  }
  return flushDeferred({ ...state, messages, fold: { ...fold, pendingToolCallIds: [] } });
}

function flushDeferred<E>(state: ContextState<E>): ContextState<E> {
  const { fold } = state;
  if (fold.pendingToolCallIds.length > 0 || fold.deferredEntries.length === 0) return state;
  return {
    messages: [...state.messages, ...fold.deferredEntries],
    fold: { ...fold, deferredEntries: [] },
  };
}

function interruptedToolMessage(toolCallId: string): ContextMessage {
  return {
    ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    isError: true,
  };
}
