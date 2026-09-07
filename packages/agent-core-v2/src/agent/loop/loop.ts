import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Error2, isError2, type Error2Options } from '#/_base/errors/errors';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { FinishReason } from '#human/llm/finish-reason';
import type { TokenUsage } from '#human/llm/usage';
import type { Hooks } from '#/hooks';
import { LoopErrors } from './errors';

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
  readonly firstStepOfTurn: boolean;
  readonly signal: AbortSignal;
}

export interface AfterStepContext extends BeforeStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  stopTurn: boolean;
}

export interface LoopErrorContext {
  readonly turnId: number;
  readonly step?: number;
  readonly stepId?: string;
  readonly signal: AbortSignal;
  readonly error: unknown;
  retry(): void;
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

export type LoopRunResult =
  | {
      readonly type: 'completed';
      readonly steps: number;
      readonly truncated: boolean;
      readonly stopReason?: string;
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

export interface Turn {
  readonly id: number;
  readonly state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly signal: AbortSignal;
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
  cancel(reason?: unknown): boolean;
}

export interface AgentLoopStatus {
  readonly state: 'idle' | 'running';
  readonly activeTurnId?: number;
  readonly pendingTurnIds: readonly number[];
  readonly hasPendingRequests: boolean;
  readonly activeTraceId?: string;
}

export interface LoopPromptSubmit {
  readonly message: ContextMessage;
  readonly origin?: PromptOrigin;
  readonly promptId?: string;
  readonly onMaterialize?: () => void;
}

export interface LoopNotify {
  readonly message?: ContextMessage;
  readonly turnScoped?: boolean;
  readonly bypassMaxSteps?: boolean;
  readonly onConsume?: () => void;
  readonly onDrop?: () => void;
}

export interface LoopNotifyHandle {
  readonly dropped: boolean;
  drop(): void;
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  submit(prompt: LoopPromptSubmit): { readonly turn: Turn };

  steer(prompt: LoopPromptSubmit): Turn | undefined;

  notify(note?: LoopNotify): LoopNotifyHandle;

  cancel(turnId?: number, reason?: unknown): boolean;

  cancelFromUser(turnId?: number): void;

  status(): AgentLoopStatus;

  tryAcquireQuiescence(): IDisposable | undefined;

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
