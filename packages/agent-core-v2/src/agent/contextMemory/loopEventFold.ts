import { isDraft, original } from 'immer';

import type { FinishReason } from '#human/llm/finish-reason';
import {
  createToolMessage,
  type ContentPart,
  type ToolCall,
  type ToolDescription,
} from '#human/llm/message';
import type { TokenUsage } from '#human/llm/usage';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import {
  isAssistantEntry,
  type HistoryMessage,
  type ToolEntry,
} from '#human/agent/turn';
import type { PromptOrigin } from '#human/agent/origin';

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
      readonly llmClientBlockedMs?: number;
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
      readonly display?: ToolInputDisplay;
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
  appendOpenToolCall(call: ToolCall, display?: ToolInputDisplay): void;
  dropOpenAssistant(): void;
  sealOpenAssistant(): void;
  pushToolMessage(entry: ToolEntry, time: number | undefined): void;
  pushMessage(entry: HistoryMessage, time: number | undefined): void;
}

export interface LoopEventFold {
  appendMessage(entry: HistoryMessage, time?: number): void;
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
  let deferred: { entry: HistoryMessage; time: number | undefined }[] = [];

  const flushDeferred = (): void => {
    if (pending.size > 0 || deferred.length === 0) return;
    for (const item of deferred) sink.pushMessage(item.entry, item.time);
    deferred = [];
  };
  const closePending = (time: number | undefined): void => {
    if (pending.size === 0) return;
    for (const toolCallId of pending) {
      sink.pushToolMessage(interruptedToolEntry(toolCallId), time);
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
    appendMessage(entry, time) {
      if (pending.size > 0) {
        deferred.push({ entry, time });
        return;
      }
      sink.pushMessage(entry, time);
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
          if (event.finishReason === 'interrupted' || event.finishReason === 'error') return;
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
          sink.appendOpenToolCall(call, event.display);
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
              message: createToolMessage(
                event.toolCallId,
                typeof output === 'string' ? output : [...output],
              ),
              meta: { isError: event.result.isError, note: event.result.note },
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
  current(): readonly HistoryMessage[];
}

interface BoundFold {
  readonly fold: LoopEventFold;
  readonly sink: ImmutableFoldSink;
}

const boundFoldMap = new WeakMap<object, BoundFold>();

export function foldAppendMessage(
  state: readonly HistoryMessage[],
  message: HistoryMessage,
): readonly HistoryMessage[] {
  const bound = boundOf(state);
  bound.fold.appendMessage(normalizeReplayedEntry(message), undefined);
  return bind(bound, bound.sink.current());
}

interface LegacyFlatMessage {
  readonly role: string;
  readonly content?: readonly ContentPart[];
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly tools?: readonly ToolDescription[];
  readonly id?: string;
  readonly origin?: PromptOrigin;
  readonly isError?: boolean;
  readonly note?: string;
  readonly toolCallDisplays?: Record<string, ToolInputDisplay>;
  readonly partial?: boolean;
}

export function normalizeReplayedEntry(raw: unknown): HistoryMessage {
  const value = raw as { readonly role?: unknown } | null;
  if (value === null || typeof value !== 'object' || typeof value.role === 'string') {
    return entryFromLegacyMessage(raw);
  }
  return raw as HistoryMessage;
}

function entryFromLegacyMessage(raw: unknown): HistoryMessage {
  const flat = raw as LegacyFlatMessage;
  const content = [...(flat.content ?? [])];
  switch (flat.role) {
    case 'system':
      return {
        message: {
          role: 'system',
          content,
          tools: flat.tools === undefined ? undefined : [...flat.tools],
        },
        meta: { origin: flat.origin },
      };
    case 'assistant':
      return {
        message: { role: 'assistant', content, toolCalls: [...(flat.toolCalls ?? [])] },
        meta: {
          toolCallDisplays: flat.toolCallDisplays,
          partial: flat.partial === true ? true : undefined,
          origin: flat.origin,
        },
      };
    case 'tool':
      return {
        message: { role: 'tool', content, toolCallId: flat.toolCallId ?? '' },
        meta: { isError: flat.isError, note: flat.note, origin: flat.origin },
      };
    default:
      return {
        message: { role: 'user', content },
        meta: { promptId: flat.id, origin: flat.origin },
      };
  }
}

export function foldLoopEvent(
  state: readonly HistoryMessage[],
  event: LoopRecordedEvent,
): readonly HistoryMessage[] {
  const bound = boundOf(state);
  bound.fold.loopEvent(event, undefined);
  return bind(bound, bound.sink.current());
}

export function resetFold(state: readonly HistoryMessage[]): readonly HistoryMessage[] {
  const sink = createImmutableFoldSink(state);
  boundFoldMap.set(state, { fold: createLoopEventFold(sink), sink });
  return state;
}

function boundOf(state: readonly HistoryMessage[]): BoundFold {
  const key = keyOf(state);
  let bound = boundFoldMap.get(key);
  if (bound === undefined || bound.sink.current() !== key) {
    const sink = createImmutableFoldSink(key);
    bound = { fold: createLoopEventFoldWithState(sink, recoverFoldState(key)), sink };
    boundFoldMap.set(key, bound);
  }
  return bound;
}

function bind(bound: BoundFold, state: readonly HistoryMessage[]): readonly HistoryMessage[] {
  boundFoldMap.set(state, bound);
  return state;
}

function keyOf(state: readonly HistoryMessage[]): readonly HistoryMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (isDraft(state) ? original(state as any) : state) as readonly HistoryMessage[];
}

function createImmutableFoldSink(initial: readonly HistoryMessage[]): ImmutableFoldSink {
  let current = initial;
  let openIndex = findOpenAssistantIndex(initial);
  const updateOpen = (update: (entry: HistoryMessage) => HistoryMessage): void => {
    if (openIndex === -1) return;
    const next = current.slice();
    next[openIndex] = update(next[openIndex]!);
    current = next;
  };
  return {
    current: () => current,
    openAssistant: () => {
      current = [
        ...current,
        { message: { role: 'assistant', content: [], toolCalls: [] }, meta: { partial: true } },
      ];
      openIndex = current.length - 1;
    },
    appendOpenContent: (part) => {
      updateOpen((entry) => {
        if (!isAssistantEntry(entry)) return entry;
        return {
          ...entry,
          message: { ...entry.message, content: [...entry.message.content, part] },
        };
      });
    },
    appendOpenToolCall: (call, display) => {
      updateOpen((entry) => {
        if (!isAssistantEntry(entry)) return entry;
        return {
          ...entry,
          message: { ...entry.message, toolCalls: [...entry.message.toolCalls, call] },
          meta: {
            ...entry.meta,
            toolCallDisplays:
              display === undefined
                ? entry.meta?.toolCallDisplays
                : { ...entry.meta?.toolCallDisplays, [call.id]: display },
          },
        };
      });
    },
    dropOpenAssistant: () => {
      if (openIndex === -1) return;
      current = [...current.slice(0, openIndex), ...current.slice(openIndex + 1)];
      openIndex = -1;
    },
    sealOpenAssistant: () => {
      updateOpen((entry) => {
        if (!isAssistantEntry(entry)) return entry;
        return { ...entry, meta: { ...entry.meta, partial: undefined } };
      });
      openIndex = -1;
    },
    pushToolMessage: (entry) => {
      current = [...current, entry];
    },
    pushMessage: (entry) => {
      current = [...current, entry];
    },
  };
}

function findOpenAssistantIndex(state: readonly HistoryMessage[]): number {
  for (let i = state.length - 1; i >= 0; i--) {
    const entry = state[i]!;
    if (isAssistantEntry(entry) && entry.meta?.partial === true) return i;
  }
  return -1;
}

function recoverFoldState(state: readonly HistoryMessage[]): InitialFoldState | undefined {
  const openIndex = findOpenAssistantIndex(state);
  if (openIndex === -1) return undefined;
  const open = state[openIndex]!;
  if (!isAssistantEntry(open)) return undefined;
  const resolvedToolCallIds = new Set<string>();
  for (let i = openIndex + 1; i < state.length; i++) {
    const entry = state[i]!;
    if (entry.message.role === 'tool' && entry.message.toolCallId !== undefined) {
      resolvedToolCallIds.add(entry.message.toolCallId);
    }
  }
  return {
    openHasToolCalls: open.message.toolCalls.length > 0,
    openVacuous: open.message.content.every(isVacuousContentPart),
    pendingToolCallIds: open.message.toolCalls
      .map((call) => call.id)
      .filter((toolCallId) => !resolvedToolCallIds.has(toolCallId)),
  };
}

function interruptedToolEntry(toolCallId: string): ToolEntry {
  return {
    message: createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    meta: { isError: true },
  };
}
