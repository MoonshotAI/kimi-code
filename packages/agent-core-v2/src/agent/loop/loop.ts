import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Error2, isError2, type Error2Options } from '#/_base/errors/errors';
import type { FinishReason } from '#/kosong/contract/provider';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { Hooks } from '#/hooks';
import { LoopErrors } from './errors';
import type { StepRequest } from './stepRequest';

export type LoopErrorCode = (typeof LoopErrors.codes)[keyof typeof LoopErrors.codes];

export class LoopError extends Error2 {
  constructor(code: LoopErrorCode, message: string, options?: Error2Options) {
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
  return isError2(error) && error.code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED;
}

export interface BeforeStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface AfterStepContext extends BeforeStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  stopTurn: boolean;
}

export interface LoopErrorContext {
  readonly currentStep?: Step;
  readonly turnId: number;
  readonly step?: number;
  readonly stepId?: string;
  readonly signal: AbortSignal;
  readonly error: unknown;
  readonly failedDriver?: StepRequest;
  retry(request: StepRequest, options?: StepEnqueueOptions): Step;
}

export interface LoopErrorHandler {
  readonly id: string;
  match(context: LoopErrorContext): boolean;
  handle(context: LoopErrorContext): Promise<boolean | undefined>;
}

export interface LoopErrorHandlerRegistrationOptions {
  readonly before?: string;
  readonly after?: string;
}

export interface LoopRunOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
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
  readonly signal: AbortSignal;
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
  readonly activeTraceId?: string;
}

export interface StepEnqueueOptions {
  readonly at?: 'head' | 'tail';
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt;

  run(options: LoopRunOptions): Promise<LoopRunResult>;

  status(): AgentLoopStatus;

  cancel(turnId?: number, reason?: unknown): boolean;

  /** Resolves once no turn is active and none are queued — the disposal drain
   *  awaited by `agentLifecycle.remove`. */
  settled(): Promise<void>;

  hasPendingRequests(): boolean;

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
