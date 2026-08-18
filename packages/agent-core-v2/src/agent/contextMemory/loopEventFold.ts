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

interface FoldCtx {
  openStepUuid: string | undefined;
  pending: Set<string>;
  deferred: ContextMessage[];
}

const foldCtxMap = new WeakMap<object, FoldCtx>();

function ctxOf(state: readonly ContextMessage[]): FoldCtx {
  const key = (isDraft(state) ? original(state as any) : state) as object;
  let ctx = foldCtxMap.get(key);
  if (ctx === undefined) {
    ctx = { openStepUuid: undefined, pending: new Set(), deferred: [] };
    foldCtxMap.set(key, ctx);
  }
  return ctx;
}

function bind(state: readonly ContextMessage[], ctx: FoldCtx): readonly ContextMessage[] {
  foldCtxMap.set(state, ctx);
  return state;
}

export function foldAppendMessage(
  state: readonly ContextMessage[],
  message: ContextMessage,
): readonly ContextMessage[] {
  const ctx = ctxOf(state);
  if (ctx.pending.size > 0) {
    ctx.deferred.push(message);
    return state;
  }
  return bind([...state, message], ctx);
}

export function foldLoopEvent(
  state: readonly ContextMessage[],
  event: LoopRecordedEvent,
): readonly ContextMessage[] {
  const ctx = ctxOf(state);
  switch (event.type) {
    case 'step.begin': {
      const settled = settleOpenStep(state, ctx);
      const assistant: ContextMessage = { role: 'assistant', content: [], toolCalls: [], partial: true };
      ctx.openStepUuid = event.uuid;
      return bind([...settled, assistant], ctx);
    }
    case 'step.end': {
      ctx.openStepUuid = undefined;
      const s = settleOpenStep(state, ctx);
      return bind(flushDeferred(s, ctx), ctx);
    }
    case 'content.part':
      return bind(appendToOpenAssistant(state, (message) => ({
        ...message,
        content: [...message.content, event.part],
      })), ctx);
    case 'tool.call': {
      const call: ToolCall = {
        type: 'function',
        id: event.toolCallId,
        name: event.name,
        arguments: event.args === undefined ? null : JSON.stringify(event.args),
        ...(event.extras !== undefined ? { extras: event.extras } : {}),
      };
      ctx.pending.add(event.toolCallId);
      return bind(appendToOpenAssistant(state, (message) => ({
        ...message,
        toolCalls: [...message.toolCalls, call],
      })), ctx);
    }
    case 'tool.result': {
      if (!ctx.pending.has(event.toolCallId)) return state;
      const output = event.result.output;
      const toolMessage: ContextMessage = {
        ...createToolMessage(event.toolCallId, typeof output === 'string' ? output : [...output]),
        isError: event.result.isError,
        note: event.result.note,
      };
      ctx.pending.delete(event.toolCallId);
      return bind(flushDeferred([...state, toolMessage], ctx), ctx);
    }
    default:
      return state;
  }
}

export function resetFold(state: readonly ContextMessage[]): readonly ContextMessage[] {
  foldCtxMap.set(state, { openStepUuid: undefined, pending: new Set(), deferred: [] });
  return state;
}

function appendToOpenAssistant(
  state: readonly ContextMessage[],
  update: (message: ContextMessage) => ContextMessage,
): readonly ContextMessage[] {
  const index = findOpenAssistantIndex(state);
  if (index === -1) return state;
  const next = state.slice();
  next[index] = update(next[index]!);
  return next;
}

function settleOpenStep(
  state: readonly ContextMessage[],
  ctx: FoldCtx,
): readonly ContextMessage[] {
  const closed = closePending(state, ctx);
  const index = findOpenAssistantIndex(closed);
  if (index === -1) return closed;
  const open = closed[index]!;
  if (open.toolCalls.length === 0 && open.content.every(isVacuousContentPart)) {
    return [...closed.slice(0, index), ...closed.slice(index + 1)];
  }
  const next = closed.slice();
  next[index] = { ...open, partial: undefined };
  return next;
}

function findOpenAssistantIndex(state: readonly ContextMessage[]): number {
  for (let i = state.length - 1; i >= 0; i--) {
    if (state[i]!.partial === true) return i;
  }
  return -1;
}

function closePending(state: readonly ContextMessage[], ctx: FoldCtx): readonly ContextMessage[] {
  if (ctx.pending.size === 0) return state;
  const next = state.slice();
  for (const toolCallId of ctx.pending) {
    next.push(interruptedToolMessage(toolCallId));
  }
  ctx.pending.clear();
  return flushDeferred(next, ctx);
}

function flushDeferred(state: readonly ContextMessage[], ctx: FoldCtx): readonly ContextMessage[] {
  if (ctx.pending.size > 0 || ctx.deferred.length === 0) return state;
  const next = [...state, ...ctx.deferred];
  ctx.deferred.length = 0;
  return next;
}

function interruptedToolMessage(toolCallId: string): ContextMessage {
  return {
    ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
    isError: true,
  };
}
