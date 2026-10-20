import type { ToolCall } from '#/llm/message';
import type { LlmModelSpec } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import {
  createAssistantEntry,
  type AssistantEntry,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#/history/message';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';
import type { LoopProfile } from '../contract/command';
import type { MessageSource, QueuedItem, TurnTrigger } from '../contract/inbox';
import type { Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from '../contract/outcome';
import type { TurnStart } from '../contract/process';
import type { HookFailure } from '../hook/failure';
import type { ToolActorRef } from '../tool/machine';

export interface ToolSlot {
  ref: ToolActorRef;
  toolCall: ToolCall;
  turnId: number;
  detached: boolean;
}

export interface TurnState {
  id: number;
  trigger: TurnTrigger;
  pending: QueuedItem[];
  step: number;
  scope: AbortScope;
  outcome?: TurnOutcome;
  resumed?: true;
}

export interface StepCall {
  key: string;
  toolCall: ToolCall;
}

export interface StepState {
  model?: LlmModelSpec;
  llm?: LlmOutcome;
  calls: StepCall[];
  settled: Record<string, ToolEntry>;
  stoppedBy?: string;
  outcome?: StepOutcome;
}

export interface LoopMachineContext {
  profile: LoopProfile;
  messages: HistoryMessage[];
  tools: Record<string, ToolSlot>;
  scope: AbortScope;
  turn?: TurnState;
  step?: StepState;
}

export type AppendedItem =
  | { source: MessageSource; entry: HistoryMessage; blocked?: Cause }
  | { source: 'notify'; entry: UserEntry; failure: HookFailure };

type Patch = Partial<LoopMachineContext>;

export function initialContext(): LoopMachineContext {
  return { profile: {}, messages: [], tools: {}, scope: createAbortScope() };
}

export function beginTurn(context: LoopMachineContext, start: TurnStart): Patch {
  return {
    profile: start.profile,
    messages: [...start.messages],
    turn: {
      id: start.id,
      trigger: start.trigger,
      pending: [...start.pending],
      step: start.step,
      scope: withAbort(context.scope.signal),
      ...(start.resumed === true ? { resumed: true as const } : {}),
    },
  };
}

export function turnOf(context: LoopMachineContext): TurnState {
  if (context.turn === undefined) throw new Error('no active turn');
  return context.turn;
}

export function stepOf(context: LoopMachineContext): StepState {
  if (context.step === undefined) throw new Error('no active step');
  return context.step;
}

export function isAborted(context: LoopMachineContext): boolean {
  return context.turn?.outcome?.type === 'aborted';
}

export function abortReason(context: LoopMachineContext): unknown {
  return context.turn?.outcome?.type === 'aborted' ? context.turn.outcome.reason : undefined;
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

export function decide(context: LoopMachineContext, outcome: StepOutcome): Patch {
  const turn = turnOf(context);
  return {
    step: { ...stepOf(context), outcome },
    turn: outcome.type === 'continue' ? turn : { ...turn, outcome },
  };
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

export function settle(step: StepState | undefined, key: string, outcome: ToolCallOutcome): StepState | undefined {
  const call = step?.calls.find((item) => item.key === key);
  if (step === undefined || call === undefined) return step;
  const stops = outcome.type !== 'aborted' && outcome.entry.meta?.stopTurn === true;
  return {
    ...step,
    settled: { ...step.settled, [key]: outcome.entry },
    stoppedBy: step.stoppedBy ?? (stops ? call.toolCall.id : undefined),
  };
}
