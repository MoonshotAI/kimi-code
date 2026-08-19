import { isDraft, original } from 'immer';

import type { FinishReason } from '#/kosong/contract/provider';
import { createToolMessage, type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';

import type { ContextMessage } from './types';
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

export interface LoopEventFoldSink {
  openAssistant(time: number | undefined): void;
  appendOpenContent(part: ContentPart): void;
  appendOpenToolCall(call: ToolCall): void;
  dropOpenAssistant(): void;
  sealOpenAssistant(): void;
  pushToolMessage(message: ContextMessage, time: number | undefined): void;
  pushMessage(message: ContextMessage, time: number | undefined): void;
}

export interface LoopEventFold {
  appendMessage(message: ContextMessage, time?: number): void;
  loopEvent(event: LoopRecordedEvent, time?: number): void;
  settle(time?: number): void;
  reset(): void;
}

export function createLoopEventFold(sink: LoopEventFoldSink): LoopEventFold {
  return createLoopEventFoldWithState(sink);
}

interface InitialFoldState {
  readonly openHasToolCalls: boolean;
  readonly openVacuous: boolean;
  readonly pendingToolCallIds: readonly string[];
}

function createLoopEventFoldWithState(
  sink: LoopEventFoldSink,
  initial?: InitialFoldState,
): LoopEventFold {
  let openStepUuid: string | null | undefined = initial === undefined ? undefined : null;
  let openHasToolCalls = initial?.openHasToolCalls ?? false;
  let openVacuous = initial?.openVacuous ?? true;
  const pending = new Set(initial?.pendingToolCallIds);
  let deferred: { message: ContextMessage; time: number | undefined }[] = [];

  const flushDeferred = (): void => {
    if (pending.size > 0 || deferred.length === 0) return;
    for (const entry of deferred) sink.pushMessage(entry.message, entry.time);
    deferred = [];
  };
  const closePending = (time: number | undefined): void => {
    if (pending.size === 0) return;
    for (const toolCallId of pending) {
      sink.pushToolMessage(interruptedToolMessage(toolCallId), time);
    }
    pending.clear();
    flushDeferred();
  };
  const settleOpen = (time: number | undefined): void => {
    if (openStepUuid === undefined) return;
    closePending(time);
    if (!openHasToolCalls && openVacuous) {
      sink.dropOpenAssistant();
    } else {
      sink.sealOpenAssistant();
    }
    openStepUuid = undefined;
  };
  const acceptsOpenStep = (stepUuid: string): boolean => {
    if (openStepUuid === undefined) return false;
    if (openStepUuid === null) {
      openStepUuid = stepUuid;
      return true;
    }
    return stepUuid === openStepUuid;
  };

  return {
    appendMessage(message, time) {
      if (pending.size > 0) {
        deferred.push({ message, time });
        return;
      }
      sink.pushMessage(message, time);
    },
    loopEvent(event, time) {
      switch (event.type) {
        case 'step.begin': {
          settleOpen(time);
          sink.openAssistant(time);
          openStepUuid = event.uuid;
          openHasToolCalls = false;
          openVacuous = true;
          return;
        }
        case 'step.end': {
          settleOpen(time);
          flushDeferred();
          return;
        }
        case 'content.part': {
          if (!acceptsOpenStep(event.stepUuid)) return;
          sink.appendOpenContent(event.part);
          openVacuous = openVacuous && isVacuousContentPart(event.part);
          return;
        }
        case 'tool.call': {
          if (!acceptsOpenStep(event.stepUuid)) return;
          const call: ToolCall = {
            type: 'function',
            id: event.toolCallId,
            name: event.name,
            arguments: event.args === undefined ? null : JSON.stringify(event.args),
            ...(event.extras !== undefined ? { extras: event.extras } : {}),
          };
          sink.appendOpenToolCall(call);
          pending.add(event.toolCallId);
          openHasToolCalls = true;
          return;
        }
        case 'tool.result': {
          if (!pending.has(event.toolCallId)) return;
          pending.delete(event.toolCallId);
          const output = event.result.output;
          sink.pushToolMessage(
            {
              ...createToolMessage(
                event.toolCallId,
                typeof output === 'string' ? output : [...output],
              ),
              isError: event.result.isError,
              note: event.result.note,
            },
            time,
          );
          flushDeferred();
          return;
        }
      }
    },
    settle(time) {
      settleOpen(time);
      flushDeferred();
    },
    reset() {
      openStepUuid = undefined;
      openHasToolCalls = false;
      openVacuous = true;
      pending.clear();
      deferred = [];
    },
  };
}

interface ImmutableFoldSink extends LoopEventFoldSink {
  current(): readonly ContextMessage[];
}

interface BoundFold {
  readonly fold: LoopEventFold;
  readonly sink: ImmutableFoldSink;
}

const boundFoldMap = new WeakMap<object, BoundFold>();

export function foldAppendMessage(
  state: readonly ContextMessage[],
  message: ContextMessage,
): readonly ContextMessage[] {
  const bound = boundOf(state);
  bound.fold.appendMessage(message, undefined);
  return bind(bound, bound.sink.current());
}

export function foldLoopEvent(
  state: readonly ContextMessage[],
  event: LoopRecordedEvent,
): readonly ContextMessage[] {
  const bound = boundOf(state);
  bound.fold.loopEvent(event, undefined);
  return bind(bound, bound.sink.current());
}

export function resetFold(state: readonly ContextMessage[]): readonly ContextMessage[] {
  const sink = createImmutableFoldSink(state);
  boundFoldMap.set(state, { fold: createLoopEventFold(sink), sink });
  return state;
}

function boundOf(state: readonly ContextMessage[]): BoundFold {
  const key = keyOf(state);
  let bound = boundFoldMap.get(key);
  if (bound === undefined || bound.sink.current() !== key) {
    const sink = createImmutableFoldSink(key);
    bound = { fold: createLoopEventFoldWithState(sink, recoverFoldState(key)), sink };
    boundFoldMap.set(key, bound);
  }
  return bound;
}

function bind(bound: BoundFold, state: readonly ContextMessage[]): readonly ContextMessage[] {
  boundFoldMap.set(state, bound);
  return state;
}

function keyOf(state: readonly ContextMessage[]): readonly ContextMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (isDraft(state) ? original(state as any) : state) as readonly ContextMessage[];
}

function createImmutableFoldSink(initial: readonly ContextMessage[]): ImmutableFoldSink {
  let current = initial;
  let openIndex = findOpenAssistantIndex(initial);
  const updateOpen = (update: (message: ContextMessage) => ContextMessage): void => {
    if (openIndex === -1) return;
    const next = current.slice();
    next[openIndex] = update(next[openIndex]!);
    current = next;
  };
  return {
    current: () => current,
    openAssistant: () => {
      current = [...current, { role: 'assistant', content: [], toolCalls: [], partial: true }];
      openIndex = current.length - 1;
    },
    appendOpenContent: (part) => {
      updateOpen((message) => ({ ...message, content: [...message.content, part] }));
    },
    appendOpenToolCall: (call) => {
      updateOpen((message) => ({ ...message, toolCalls: [...message.toolCalls, call] }));
    },
    dropOpenAssistant: () => {
      if (openIndex === -1) return;
      current = [...current.slice(0, openIndex), ...current.slice(openIndex + 1)];
      openIndex = -1;
    },
    sealOpenAssistant: () => {
      updateOpen((message) => ({ ...message, partial: undefined }));
      openIndex = -1;
    },
    pushToolMessage: (message) => {
      current = [...current, message];
    },
    pushMessage: (message) => {
      current = [...current, message];
    },
  };
}

function findOpenAssistantIndex(state: readonly ContextMessage[]): number {
  for (let i = state.length - 1; i >= 0; i--) {
    if (state[i]!.partial === true) return i;
  }
  return -1;
}

function recoverFoldState(state: readonly ContextMessage[]): InitialFoldState | undefined {
  const openIndex = findOpenAssistantIndex(state);
  if (openIndex === -1) return undefined;
  const open = state[openIndex]!;
  const resolvedToolCallIds = new Set<string>();
  for (let i = openIndex + 1; i < state.length; i++) {
    const message = state[i]!;
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      resolvedToolCallIds.add(message.toolCallId);
    }
  }
  return {
    openHasToolCalls: open.toolCalls.length > 0,
    openVacuous: open.content.every(isVacuousContentPart),
    pendingToolCallIds: open.toolCalls
      .map((call) => call.id)
      .filter((toolCallId) => !resolvedToolCallIds.has(toolCallId)),
  };
}

function interruptedToolMessage(toolCallId: string): ContextMessage {
  return {
    ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    isError: true,
  };
}
