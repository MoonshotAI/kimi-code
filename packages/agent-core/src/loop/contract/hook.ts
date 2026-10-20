import type { ToolCall } from '#/llm/message';
import type { HistoryMessage } from '#/history/message';
import type { ToolResult } from '#/tool/index';
import type { LoopProfile } from './command';
import type { QueuedItem, TurnTrigger } from './inbox';
import type { Cause, StepOutcome } from './outcome';

export interface TurnStartingEvent {
  readonly turnId: number;
  readonly trigger: TurnTrigger;
  readonly pending: readonly QueuedItem[];
}

export interface MessageAppendingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly item: QueuedItem;
}

export interface StepStartingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly messages: readonly HistoryMessage[];
  readonly profile: LoopProfile;
}

export interface ToolBatchStartingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolStartingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly toolCall: ToolCall;
}

export type ToolPermittingEvent = ToolStartingEvent;

export interface ToolEndingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
  readonly failed: boolean;
}

export interface StepStoppingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly draft: Extract<StepOutcome, { type: 'done' | 'failed' }>;
  readonly messages: readonly HistoryMessage[];
}

export interface StepContinuingEvent {
  readonly turnId: number;
  readonly step: number;
  readonly cause?: Cause;
  readonly messages: readonly HistoryMessage[];
}

export type TurnStartingVerdict = { readonly type: 'blocked'; readonly cause: Cause };

export type MessageAppendingDecision = { readonly entry?: HistoryMessage; readonly blocked?: Cause };

export type StepStartingDecision = {
  readonly messages?: readonly HistoryMessage[];
  readonly blocked?: Cause;
};

export type ToolBatchStartingDecision = { readonly blocked: Cause; readonly result?: ToolResult };

export type ToolStartingDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: Cause; readonly result?: ToolResult };

export type ToolPermittingDecision = ToolStartingDecision;

export type ToolEndingDecision = { readonly result?: ToolResult; readonly stopTurn?: true };

export type StepStoppingVerdict = { readonly type: 'continue'; readonly cause: Cause };

export type StepContinuingVerdict = { readonly type: 'done' | 'blocked'; readonly cause: Cause };

type Hook<E, D> = (event: E, signal: AbortSignal) => Promise<void | D> | void | D;

export interface LoopHooks {
  readonly 'turn.starting': Hook<TurnStartingEvent, TurnStartingVerdict>;
  readonly 'message.appending': Hook<MessageAppendingEvent, MessageAppendingDecision>;
  readonly 'step.starting': Hook<StepStartingEvent, StepStartingDecision>;
  readonly 'tool.batch-starting': Hook<ToolBatchStartingEvent, ToolBatchStartingDecision>;
  readonly 'tool.starting': Hook<ToolStartingEvent, ToolStartingDecision>;
  readonly 'tool.permitting': Hook<ToolPermittingEvent, ToolPermittingDecision>;
  readonly 'tool.ending': Hook<ToolEndingEvent, ToolEndingDecision>;
  readonly 'step.stopping': Hook<StepStoppingEvent, StepStoppingVerdict>;
  readonly 'step.continuing': Hook<StepContinuingEvent, StepContinuingVerdict>;
}

export type HookPoint = keyof LoopHooks;

export type HookFailurePolicy = 'pause' | 'block';

export type HookRegistration = {
  [P in HookPoint]: {
    readonly point: P;
    readonly hook: LoopHooks[P];
    readonly id?: string;
    readonly onFailure?: HookFailurePolicy;
  };
}[HookPoint];

export interface HookInfo {
  readonly id: string;
  readonly point: HookPoint;
  readonly onFailure: HookFailurePolicy;
  readonly paused: boolean;
}

export type HookLifecycleEvent =
  | { type: 'hook.added'; hookId: string; point: HookPoint }
  | { type: 'hook.paused'; hookId: string; point: HookPoint; reason: 'manual' | 'failed' }
  | { type: 'hook.resumed'; hookId: string; point: HookPoint }
  | { type: 'hook.removed'; hookId: string; point: HookPoint };
