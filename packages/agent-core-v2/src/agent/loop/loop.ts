import { createDecorator } from '#/_base/di/instantiation';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { Hooks } from '#/hooks';
import type { TurnEndReason } from '@moonshot-ai/protocol';

export interface BeforeStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface AfterStepContext extends BeforeStepContext {
  readonly usage: TokenUsage;
  readonly finishReason: FinishReason;
  continue: boolean;
}

export interface LoopErrorContext {
  readonly turnId: number;
  /** The currently executing step, or undefined for turn-level failures. */
  readonly step?: number;
  readonly signal: AbortSignal;
  readonly error: unknown;
  /**
   * Set to true only after a handler has changed state enough for the loop to
   * retry. Handlers that do not recognize the error must call next().
   */
  retry: boolean;
}

export interface LoopRunOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
  /** Fires on the first model response event for a step, or at step completion. */
  readonly onStarted?: (step: number) => void;
}

export interface LoopRunResult {
  readonly reason: TurnEndReason;
  readonly error?: unknown;
  readonly steps?: number;
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  run(options: LoopRunOptions): Promise<LoopRunResult>;

  readonly hooks: Hooks<{
    beforeStep: BeforeStepContext;
    afterStep: AfterStepContext;
    onError: LoopErrorContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
