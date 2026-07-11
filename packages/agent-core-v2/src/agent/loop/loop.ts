import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { KimiError, isKimiError, type KimiErrorOptions } from '#/_base/errors/errors';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { Hooks } from '#/hooks';
import { LoopErrors } from './errors';
import type { StepRequest } from './stepRequest';

export type LoopErrorCode = (typeof LoopErrors.codes)[keyof typeof LoopErrors.codes];

export class LoopError extends KimiError {
  constructor(code: LoopErrorCode, message: string, options?: KimiErrorOptions) {
    super(code, message, options);
    this.name = 'LoopError';
  }
}

export function createMaxStepsExceededError(maxSteps: number, message?: string): LoopError {
  return new LoopError(
    LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED,
    message ??
      `Turn exceeded maxSteps=${maxSteps}. If max_steps_per_turn is too small, raise it in config.toml (loop_control.max_steps_per_turn), or run "/update-config" to update it, then "/reload".`,
    { details: { maxSteps } },
  );
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return isKimiError(error) && error.code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED;
}

export interface BeforeStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface AfterStepContext extends BeforeStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  /**
   * Set to true to end the turn at this step boundary. Takes precedence in
   * the run loop over both requested tool calls and any queued step
   * requests, so a hard stop (e.g. a reached goal budget) cannot be
   * overridden by another hook's continuation.
   */
  stopTurn: boolean;
}

export interface LoopErrorContext {
  readonly currentStep?: Step;
  readonly turnId: number;
  /** The currently executing step, or undefined for turn-level failures. */
  readonly step?: number;
  /** The failed step's wire uuid, when the failure happened inside a step. */
  readonly stepId?: string;
  readonly signal: AbortSignal;
  readonly error: unknown;
  /**
   * The driver whose step failed; already popped from the queue. A handler
   * that recovers by re-running the step enqueues it back (at the head of
   * the queue) itself before reporting the error as caught.
   */
  readonly failedDriver?: StepRequest;
  /** Reinsert recovery work into the failed driver's original Turn. */
  retry(request: StepRequest, options?: StepEnqueueOptions): Step;
}

export interface LoopErrorHandler {
  readonly id: string;
  /** Claim the error: the first matching handler in registration order handles it. */
  match(context: LoopErrorContext): boolean;
  /**
   * Recover from a claimed error. Awaiting inside the handler (backoff sleeps,
   * compaction) suspends the loop in its catch path — aborting `context.signal`
   * still cancels the turn. Resolve `true` when the error is caught: the
   * handler has already arranged how the turn continues (typically by
   * enqueueing the requests it wants run next) and the loop simply drains on,
   * learning nothing but caught-or-not. Resolve `false`/`undefined` to fail
   * the turn with the original error; throwing fails it with the handler's
   * error.
   */
  handle(context: LoopErrorContext): Promise<boolean | undefined>;
}

export interface LoopErrorHandlerRegistrationOptions {
  readonly before?: string;
  readonly after?: string;
}

export interface LoopRunOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
  /** Fires on the first model response event for a step, or at step completion. */
  readonly onStarted?: (step: number) => void;
}

export type LoopRunResult =
  | {
      readonly type: 'completed';
      readonly steps: number;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'failed';
      readonly steps: number;
      readonly error: unknown;
    }
  | {
      readonly type: 'cancelled';
      readonly steps: number;
      readonly reason: unknown;
    };

export type TurnResult = LoopRunResult;

export type StepState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StepResult =
  | { readonly type: 'completed' }
  | { readonly type: 'failed'; readonly error: unknown }
  | { readonly type: 'cancelled'; readonly reason: unknown };

export interface Step {
  readonly id: string;
  readonly turnId: number;
  readonly state: StepState;
  readonly signal: AbortSignal;
  readonly result: Promise<StepResult>;
  cancel(reason?: unknown): boolean;
}

export interface Turn {
  readonly id: number;
  readonly state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * Cancellation signal owned by the `activity` kernel's turn lease. Abort it
   * through `IAgentLoopService.cancel(...)` rather than holding a controller;
   * the kernel is the single authority for turn cancellation.
   */
  readonly signal: AbortSignal;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
  cancel(reason?: unknown): boolean;
}

export interface StepAssignment {
  readonly turn: Turn;
  readonly step: Step;
}

export interface EnqueueReceipt {
  readonly assigned: Promise<StepAssignment>;
  abort(reason?: unknown): boolean;
}

export interface AgentLoopStatus {
  readonly state: 'idle' | 'running';
  readonly activeTurnId?: number;
  readonly pendingTurnIds: readonly number[];
  readonly hasPendingRequests: boolean;
}

export interface StepEnqueueOptions {
  /** `tail` (default) preserves order for normal work; `head` jumps the queue (used to retry a failed step). */
  readonly at?: 'head' | 'tail';
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  /** Atomically admits a request according to its admission semantics. */
  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt;

  /** Low-level loop runner used by focused loop tests and recovery integrations. */
  run(options: LoopRunOptions): Promise<LoopRunResult>;

  /** Read-only scheduling state. */
  status(): AgentLoopStatus;

  /**
   * Cancel the active turn (optionally only when its id matches `turnId`),
   * recording `turn.cancel` on the wire. The `activity` kernel owns the actual
   * abort; returns false when no (matching) turn is active.
   */
  cancel(turnId?: number, reason?: unknown): boolean;

  /** True while any non-aborted step request is queued. */
  hasPendingRequests(): boolean;

  /**
   * Register a recovery handler for step failures. Handlers dispatch in
   * registration order, first match wins — the loop itself knows nothing
   * about concrete error types: retry policies (`stepRetry`) and overflow
   * recovery (`fullCompaction`) plug in here. A handler that catches an
   * error arranges the turn's continuation itself; the loop only learns
   * whether the error was caught.
   */
  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options?: LoopErrorHandlerRegistrationOptions,
  ): IDisposable;

  readonly hooks: Hooks<{
    onWillBeginStep: BeforeStepContext;
    onDidFinishStep: AfterStepContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
