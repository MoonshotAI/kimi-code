import {
  createAssistantEntry,
  type AssistantEntry,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#/history/message';
import type { ToolCall } from '#/llm/message';
import type { LlmModelSpec } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import type { ToolResult } from '#/tool/index';
import { withAbort, type AbortScope } from '#/utils/abort';
import type { Inbox, MessageSource, QueuedItem, TurnTrigger } from './contract/inbox';
import type { Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from './contract/outcome';
import type { LoopProfile } from './contract/profile';
import type { HookFailure } from './hook/failure';
import type { LoopRecordState } from './record';

export interface LoopTurn {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
}

export interface LoopToolCall {
  readonly toolCall: ToolCall;
  readonly turnId: number;
  readonly detached: boolean;
}

export interface LoopState {
  readonly status: 'idle' | 'running' | 'interrupted';
  readonly held: boolean;
  readonly inbox: Readonly<Inbox>;
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly nextTurnId: number;
  readonly turn?: LoopTurn;
  readonly calls: readonly LoopToolCall[];
}

export interface TurnCompletion {
  readonly promise: Promise<TurnOutcome>;
  resolve(outcome: TurnOutcome): void;
}

export type TurnPhase =
  | 'starting'
  | 'appending'
  | 'stepStarting'
  | 'requesting'
  | 'batching'
  | 'acting'
  | 'ending'
  | 'draining'
  | 'finished';

export interface LiveTurn extends LoopTurn {
  step: number;
  phase: TurnPhase;
  pending: QueuedItem[];
  readonly scope: AbortScope;
  outcome?: TurnOutcome;
  readonly resumed?: true;
  announced: boolean;
  readonly completion?: TurnCompletion;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  abortGrace?: ReturnType<typeof setTimeout>;
}

export interface StepCall {
  readonly key: string;
  readonly toolCall: ToolCall;
}

export interface StepState {
  model?: LlmModelSpec;
  llm?: LlmOutcome;
  readonly calls: StepCall[];
  readonly settled: Record<string, ToolEntry>;
  stoppedBy?: string;
  outcome?: StepOutcome;
}

export type ToolStatus = 'succeeded' | 'failed' | 'aborted';

export interface LiveTool {
  readonly key: string;
  toolCall: ToolCall;
  readonly turnId: number;
  readonly step: number;
  readonly scope: AbortScope;
  detached: boolean;
  announced: boolean;
  done: boolean;
  status?: ToolStatus;
  result?: ToolResult;
  error?: unknown;
  reason?: unknown;
  readonly waiters: Set<() => void>;
}

export type AppendedItem =
  | { source: MessageSource; entry: HistoryMessage; blocked?: Cause }
  | { source: 'notify'; entry: UserEntry; failure: HookFailure };

export function canContinue(messages: readonly HistoryMessage[]): boolean {
  const role = messages.at(-1)?.message.role;
  return role === 'user' || role === 'tool';
}

export function trailingCalls(messages: readonly HistoryMessage[]): { unresolved: ToolCall[]; stopped: boolean } {
  const index = messages.findLastIndex((entry) => entry.message.role === 'assistant');
  const assistant = messages[index]?.message;
  if (assistant?.role !== 'assistant') return { unresolved: [], stopped: false };
  const after = messages.slice(index + 1);
  const results = after.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
  const answered = new Set(results.map((entry) => entry.message.toolCallId));
  return {
    unresolved: assistant.toolCalls.filter((toolCall) => !answered.has(toolCall.id)),
    stopped: results.length === after.length && results.some((entry) => entry.meta?.stopTurn === true),
  };
}

export function isResumable(durable: LoopRecordState): boolean {
  if (durable.unfinished?.appended !== true) return false;
  const { unresolved, stopped } = trailingCalls(durable.messages);
  return !stopped && (unresolved.length > 0 || canContinue(durable.messages));
}

interface CreateTurnInput {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly pending: readonly QueuedItem[];
  readonly resumed?: true;
  readonly completion?: TurnCompletion;
  readonly signal?: AbortSignal;
}

export function createTurn(root: AbortScope, input: CreateTurnInput): LiveTurn {
  return {
    id: input.id,
    trigger: input.trigger,
    step: input.step,
    pending: [...input.pending],
    scope: withAbort(root.signal),
    phase: input.resumed === true ? 'draining' : 'starting',
    announced: false,
    ...(input.resumed === true ? { resumed: true as const } : {}),
    ...(input.completion === undefined ? {} : { completion: input.completion }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

export function draftOutcome(step: StepState): StepOutcome {
  const llm = step.llm;
  if (llm === undefined) return { type: 'failed' };
  if (llm.type === 'aborted') return { type: 'aborted', reason: llm.reason };
  if (llm.type === 'failed') {
    return { type: 'failed', error: llm.error.kind === 'syntax' ? llm.error : (llm.rawError ?? llm.error) };
  }
  if (step.stoppedBy !== undefined) return { type: 'done', cause: { by: step.stoppedBy, reason: 'stop_turn' } };
  if (llm.message.toolCalls.length === 0) return { type: 'done' };
  return { type: 'continue' };
}

export function assistantEntryOf(outcome: LlmOutcome, model?: LlmModelSpec): AssistantEntry | undefined {
  if (outcome.type === 'failed' || outcome.message === null) return undefined;
  return createAssistantEntry(outcome.message, {
    source: outcome.type === 'done' ? 'llm' : 'salvaged',
    ...(model === undefined ? {} : { model: { provider: model.provider, model: model.name } }),
    usage: outcome.usage,
    headers: outcome.headers,
    finish: outcome.finish,
    messageId: outcome.messageId,
  });
}

export function allSettled(step: StepState | undefined): boolean {
  return step !== undefined && step.calls.every((call) => step.settled[call.key] !== undefined);
}

export function settle(step: StepState, key: string, outcome: ToolCallOutcome): void {
  const call = step.calls.find((item) => item.key === key);
  if (call === undefined || step.settled[key] !== undefined) return;
  step.settled[key] = outcome.entry;
  if (outcome.type !== 'aborted' && outcome.entry.meta?.stopTurn === true) step.stoppedBy ??= call.toolCall.id;
}
