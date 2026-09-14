import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Error2, isError2, type Error2Options } from '#/_base/errors/errors';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { FinishReason } from '#human/llm/finish-reason';
import type { ContentPart } from '#human/llm/message';
import type { TokenUsage } from '#human/llm/usage';
import type { Hooks } from '#/hooks';
import type { UserEntry } from '#human/agent/turn';
import { LoopErrors } from './errors';
import type {
  MachineEngine,
  MachineEngineAttachBundle,
  MachineEngineAttachRef,
  MachineEngineRetrySnapshot,
  MachineEngineToolCallSnapshot,
} from './machine/engine';

export interface AgentActivityTurnSnapshot {
  readonly turnId: number;
  readonly phase: 'running' | 'tool_call' | 'retrying';
  readonly step: number;
  readonly ending: boolean;
  readonly endingReason?: 'aborted';
  readonly retry?: MachineEngineRetrySnapshot;
  readonly activeToolCalls: readonly MachineEngineToolCallSnapshot[];
  readonly since?: number;
}

export interface AgentActivitySnapshot {
  readonly turn?: AgentActivityTurnSnapshot;
}

export interface LoopSnapshot {
  readonly state: 'idle' | 'running';
  readonly activeTurnId?: number;
  readonly activePromptId?: string;
  readonly queue: readonly UserEntry[];
  readonly notificationCount: number;
  readonly paused: boolean;
  readonly hasPendingRequests: boolean;
  readonly turn?: AgentActivityTurnSnapshot;
  readonly activeTraceId?: string;
}

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
  readonly id?: number;
  readonly state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly signal: AbortSignal;
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
  cancel(reason?: unknown): boolean;
}

export interface LoopSubmitOptions {
  readonly steerIfActive?: boolean;
  readonly onMaterialize?: () => void;
}

export interface LoopSubmitResult {
  readonly id: string;
}

export interface LoopCancelTarget {
  readonly turnId?: number;
  readonly promptId?: string;
}

export type PromptState =
  | 'pending'
  | 'running'
  | 'steered'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface PromptCompletion {
  readonly promptId: string;
  readonly result: TurnResult | undefined;
  readonly state: Extract<PromptState, 'completed' | 'failed' | 'cancelled' | 'blocked'>;
}

export interface PromptSnapshot {
  readonly id: string;
  readonly userMessageId: string;
  readonly createdAt: string;
  readonly state: PromptState;
  readonly message: ContextMessage;
}

export interface PromptHandle extends PromptSnapshot {
  readonly launched: Promise<Turn | undefined>;
  readonly completion: Promise<PromptCompletion>;
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  readonly promptId?: string;
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

export interface PromptSubmitContext {
  readonly promptMessage: ContextMessage;
  readonly isSteer: boolean;
  block: boolean;
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

  submit(input: UserEntry, options?: LoopSubmitOptions): LoopSubmitResult;

  steer(promptIds: readonly string[]): Promise<void>;

  cancel(target?: LoopCancelTarget, reason?: unknown): boolean;

  snapshot(): LoopSnapshot;

  settled(): Promise<void>;

  tryAcquireQuiescence(): IDisposable | undefined;

  notify(note?: LoopNotify): LoopNotifyHandle;

  buildAttachBundle(): MachineEngineAttachBundle;

  attachEngine(ref: MachineEngineAttachRef, bundle: MachineEngineAttachBundle): MachineEngine;

  resetMachineEngine(): Promise<void>;

  promptHandle(id: string): PromptHandle | undefined;

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options?: LoopErrorHandlerRegistrationOptions,
  ): IDisposable;

  readonly hooks: Hooks<{
    onWillBeginStep: BeforeStepContext;
    onDidFinishStep: AfterStepContext;
    onBeforeSubmitPrompt: PromptSubmitContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
