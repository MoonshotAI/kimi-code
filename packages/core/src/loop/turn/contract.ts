import type { Message, ToolCall } from '#/llm/message';
import type { PolicyRegistry } from '#/llm/policy/registry';
import type { LlmOutcome } from '#/llm/response';
import type { LoopEmitted } from '../contract/emitted';
import type { HookPoint, LoopHooks, ToolResult as LoopHookToolResult } from '../contract/hook';
import type { QueuedItem, TurnTrigger } from '../contract/inbox';
import type { Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from '../contract/outcome';
import type { LoopProfile } from '../contract/profile';
import type { HookFailure, HookFailureReport } from '#/hook/loop/failure';
import type { LoopLlmRequester } from '../request';

export type TurnMessageSource = 'normal' | 'notify' | 'remind';
export type TurnHookFailure = HookFailure;
export type TurnHookFailureReport = HookFailureReport;

export interface TurnMessage<M extends Message = Message> {
  readonly source: TurnMessageSource;
  readonly message: M;
  readonly blocked?: Cause;
  readonly failure?: TurnHookFailure;
}

export interface TurnInput {
  readonly id: number;
  readonly start:
    | {
        readonly type: 'prompt';
        readonly trigger: 'normal' | 'notify';
        readonly pending: readonly QueuedItem[];
        readonly promptOnly?: true;
      }
    | { readonly type: 'continue' }
    | { readonly type: 'resume'; readonly trigger: TurnTrigger; readonly step: number };
  readonly bypassMaxSteps?: boolean;
  readonly signal?: AbortSignal;
}

export interface TurnPoint {
  readonly turnId: number;
  readonly step: number;
}

export interface TurnOwnerStartingEvent extends TurnPoint {
  readonly trigger: TurnTrigger;
  readonly pending: readonly QueuedItem[];
  readonly resumed: boolean;
}

export interface TurnStartDecision {
  readonly blocked?: Cause;
  readonly done?: Cause;
}

export type TurnYield = { readonly type: 'done'; readonly cause: Cause };

export type TurnPhase =
  | 'starting'
  | 'appending'
  | 'stepStarting'
  | 'requesting'
  | 'batching'
  | 'acting'
  | 'ending'
  | 'finished';

export interface TurnEnding {
  readonly turnId: number;
  readonly outcome: TurnOutcome;
  readonly at: 'created' | TurnPhase;
  readonly uncommitted: readonly TurnMessage[];
}

export interface TurnHookContext {
  readonly signal: AbortSignal;
  append(...messages: readonly TurnMessage[]): void;
}

export interface TurnHooks {
  readonly starting: (
    event: TurnOwnerStartingEvent,
    ctx: TurnHookContext,
  ) => TurnStartDecision | void | Promise<TurnStartDecision | void>;
  readonly requesting: (
    event: TurnPoint,
    ctx: TurnHookContext,
  ) => TurnYield | void | Promise<TurnYield | void>;
  readonly continuing: (
    event: TurnPoint,
    ctx: TurnHookContext,
  ) => TurnYield | void | Promise<TurnYield | void>;
  readonly ending: (event: TurnEnding, ctx: Pick<TurnHookContext, 'append'>) => void;
}

type TurnOnlyEvent = {
  type:
    | 'prompt.submitted'
    | 'prompt.notified'
    | 'prompt.reminded'
    | 'prompt.steered'
    | 'prompt.canceled'
    | 'turn.started'
    | 'turn.resumed'
    | 'tool.async_ended';
};

export type TurnEmitted = Exclude<LoopEmitted, TurnOnlyEvent>;

export interface StepCall {
  readonly key: string;
  readonly toolCall: ToolCall;
}

export interface TurnToolBatch extends TurnPoint {
  readonly calls: readonly StepCall[];
  readonly signal: AbortSignal;
  readonly blocked?: { readonly cause: Cause; readonly result?: LoopHookToolResult };
  readonly aborted?: { readonly reason: unknown };
}

export interface TurnToolBatchResult {
  readonly outcomes: readonly (ToolCallOutcome | null)[];
  readonly failure?: unknown;
}

export interface TurnToolRuntime {
  executeBatch(batch: TurnToolBatch): TurnToolBatchResult | Promise<TurnToolBatchResult>;
  abortBatch(
    batch: TurnToolBatch,
    reason: unknown,
    options?: { readonly force?: boolean },
  ): TurnToolBatchResult | undefined;
}

export interface TurnRequestRuntime {
  current(): LoopLlmRequester | undefined;
  readonly policy: PolicyRegistry;
}

export interface TurnHost {
  read(): { readonly messages: readonly Message[]; readonly profile: LoopProfile };
  emit(event: TurnEmitted): void;
  transition<T>(run: () => T): T;
  report(
    point: HookPoint,
    event: TurnPoint,
    reports: readonly TurnHookFailureReport[],
    notify: boolean,
  ): void;
  committed(turnId: number): void;
}

export interface TurnRuntime {
  readonly request: TurnRequestRuntime;
  readonly tools: TurnToolRuntime;
  readonly hooks: Partial<TurnHooks>;
  readonly extensions: Partial<LoopHooks>;
  readonly host: TurnHost;
  readonly signal: AbortSignal;
  readonly abortGraceMs?: number;
}

export interface TurnState {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly phase: 'created' | TurnPhase;
  readonly step: number;
  readonly outcome?: TurnOutcome;
  readonly bypassMaxSteps: boolean;
}

export interface Turn {
  readonly id: number;
  readonly state: TurnState;
  readonly done: Promise<TurnOutcome>;
  start(): void;
  interrupt(cause?: Cause): void;
  abort(reason?: unknown, options?: { readonly force?: boolean }): void;
}

export interface TurnStep {
  readonly scope: { readonly signal: AbortSignal; abort(reason?: unknown): void };
  steerRequested: boolean;
  toolCallStreaming: boolean;
  llm?: LlmOutcome;
  readonly calls: StepCall[];
  outcome?: StepOutcome;
}

