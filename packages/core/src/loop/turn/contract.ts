import type { Message, ToolCall } from '#/llm/message';
import type { PolicyRegistry } from '#/llm/policy/registry';
import type { LlmOutcome } from '#/llm/response';
import type { LoopEmitted } from '../contract/emitted';
import type { HookPoint, HookToolResult, LoopHooks } from '../contract/hook';
import type { QueuedItem, TurnTrigger } from '../contract/inbox';
import type { Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from '../contract/outcome';
import type { LoopProfile } from '../contract/profile';
import type { HookFailure, HookFailureReport } from '#/hook/loop/failure';
import type { StepEndingRun } from '#/hook/loop/run';
import type { LoopLlmRequester } from '../request';

export type TurnMessage = Pick<QueuedItem, 'kind'> & {
  readonly message: Message;
  readonly blocked?: Cause;
  readonly failure?: HookFailure;
};

export interface TurnPoint {
  readonly turnId: number;
  readonly step: number;
}

export type TurnPhase =
  | 'starting'
  | 'appending'
  | 'stepStarting'
  | 'requesting'
  | 'batching'
  | 'acting'
  | 'aborting'
  | 'ending'
  | 'finishing'
  | 'finished';

export interface TurnEnding {
  readonly turn: TurnState & { readonly outcome: TurnOutcome };
  readonly at: 'created' | TurnPhase;
  readonly uncommitted: readonly TurnMessage[];
}

export interface TurnHookContext {
  readonly signal: AbortSignal;
  append(...messages: readonly TurnMessage[]): void;
}

export interface TurnHooks {
  readonly starting: (
    turn: TurnState,
    ctx: TurnHookContext,
  ) => Extract<TurnOutcome, { type: 'done' | 'blocked' }> | void | Promise<Extract<TurnOutcome, { type: 'done' | 'blocked' }> | void>;
  readonly requesting: (
    turn: TurnState,
    ctx: TurnHookContext,
  ) => Extract<TurnOutcome, { type: 'done' }> | void | Promise<Extract<TurnOutcome, { type: 'done' }> | void>;
  readonly continuing: (
    turn: TurnState,
    ctx: TurnHookContext,
  ) => Extract<TurnOutcome, { type: 'done' }> | void | Promise<Extract<TurnOutcome, { type: 'done' }> | void>;
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
  readonly calls: StepCall[];
  readonly signal: AbortSignal;
  blocked?: { readonly cause: Cause; readonly result?: HookToolResult };
  aborted?: { readonly reason: unknown };
}

export interface TurnToolBatchResult {
  readonly outcomes: readonly (ToolCallOutcome | null)[];
  readonly failure?: unknown;
}

export interface TurnRuntime {
  requester(): LoopLlmRequester | undefined;
  readonly policy: PolicyRegistry;
  executeBatch(batch: TurnToolBatch): TurnToolBatchResult | Promise<TurnToolBatchResult>;
  abortBatch(
    batch: TurnToolBatch,
    reason: unknown,
    options?: { readonly force?: boolean },
  ): TurnToolBatchResult | undefined;
  read(): { readonly messages: readonly Message[]; readonly profile: LoopProfile };
  emit(event: TurnEmitted): void;
  transition<T>(run: () => T): T;
  report(
    point: HookPoint,
    event: TurnPoint,
    reports: readonly HookFailureReport[],
    notify: boolean,
  ): void;
  committed(turnId: number): void;
  readonly hooks: Partial<TurnHooks>;
  readonly extensions: Partial<LoopHooks>;
  readonly signal: AbortSignal;
  readonly abortGraceMs?: number;
}

export interface TurnState {
  readonly id: number;
  readonly kind: 'prompt' | 'continue' | 'resume';
  readonly trigger: TurnTrigger;
  readonly initialPending: readonly QueuedItem[];
  readonly promptOnly: boolean;
  readonly bypassMaxSteps: boolean;
  readonly phase: 'created' | TurnPhase;
  readonly step: number;
  readonly outcome?: TurnOutcome;
}

export type TurnInput = Omit<TurnState, 'phase' | 'outcome'>;

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
  readonly batch: TurnToolBatch;
  steerRequested: boolean;
  toolCallStreaming: boolean;
  llm?: LlmOutcome;
  ending?: StepEndingRun | Promise<StepEndingRun>;
  outcome?: StepOutcome;
}
