/**
 * `contextMemory` loop-event fold — restore-time reduction of v1
 * `context.append_loop_event` records into folded `ContextMessage`s.
 *
 * v2's agent loop persists assistant / tool messages already folded
 * (`context.append_message`); it never emits loop events. Sessions written by
 * the v1 loop (`packages/agent-core`), however, stream a turn as
 * `context.append_loop_event` records (`step.begin` / `content.part` /
 * `tool.call` / `tool.result` / `step.end`) and never write a folded assistant
 * message. Without this fold, `WireService.replay` skips those records (no Op
 * is registered for the type) and the restored `ContextModel` — and every
 * consumer built on it (`/messages`, `/snapshot`, live resume) — shows only the
 * user prompts.
 *
 * Semantics mirror v1's `ContextMemory.appendLoopEvent`
 * (`packages/agent-core/src/agent/context/index.ts`) and the transcript
 * reducer (`packages/agent-core/src/services/message/transcript.ts`) exactly:
 *   - `step.begin`  → open an assistant message (`partial: true`); first close
 *                     any tool exchange left open by a previous step
 *   - `content.part`→ append to the open assistant's content
 *   - `tool.call`   → append to the open assistant's `toolCalls`, mark pending
 *   - `tool.result` → push a `tool` message (v1 `toolResultOutputForModel`
 *                     wrapping), clear its pending id
 *   - `step.end`    → close the assistant (`partial: undefined`)
 * A `context.append_message` reduced while a tool exchange is still open is
 * deferred and flushed once the exchange closes, so strict-provider
 * assistant↔tool adjacency is preserved.
 *
 * The fold is stateful across records within one replay. State is carried in a
 * `WeakMap` keyed by each evolving state array, so the public
 * `wire.getModel(ContextModel)` view stays a plain `ContextMessage[]` and
 * concurrent replays of different agent scopes never share fold state.
 */

import { createToolMessage, type ContentPart, type ToolCall } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';

import type { ContextMessage } from './types';

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
      readonly providerFinishReason?: string;
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
  let ctx = foldCtxMap.get(state);
  if (ctx === undefined) {
    ctx = { openStepUuid: undefined, pending: new Set(), deferred: [] };
    foldCtxMap.set(state, ctx);
  }
  return ctx;
}

function bind(state: readonly ContextMessage[], ctx: FoldCtx): readonly ContextMessage[] {
  foldCtxMap.set(state, ctx);
  return state;
}

/** Defer-aware `context.append_message` (matches v1 `ContextMemory.appendMessage`). */
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

/** Reduce one `context.append_loop_event` record into the history. */
export function foldLoopEvent(
  state: readonly ContextMessage[],
  event: LoopRecordedEvent,
): readonly ContextMessage[] {
  const ctx = ctxOf(state);
  switch (event.type) {
    case 'step.begin': {
      const closed = closePending(state, ctx);
      const assistant: ContextMessage = { role: 'assistant', content: [], toolCalls: [], partial: true };
      ctx.openStepUuid = event.uuid;
      return bind([...closed, assistant], ctx);
    }
    case 'step.end': {
      ctx.openStepUuid = undefined;
      const s = clearPartial(state);
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

/**
 * Clear fold bookkeeping after an op that invalidates any open exchange
 * (`context.undo` / `context.clear` / `context.apply_compaction` /
 * `context.splice`). Returns the same state reference with a fresh fold ctx.
 */
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

function clearPartial(state: readonly ContextMessage[]): readonly ContextMessage[] {
  const index = findOpenAssistantIndex(state);
  if (index === -1) return state;
  const next = state.slice();
  next[index] = { ...next[index]!, partial: undefined };
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
