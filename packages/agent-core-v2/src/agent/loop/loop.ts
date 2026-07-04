import { createDecorator } from '#/_base/di';
import type { FinishReason, TokenUsage } from '#/app/llmProtocol';
import type { Hooks } from '#/hooks';
import type { TurnEndReason } from '@moonshot-ai/protocol';

export interface TurnBeforeStepContext {
  readonly turnId: number;
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface TurnAfterStepContext extends TurnBeforeStepContext {
  readonly usage: TokenUsage;
  readonly stopReason: FinishReason;
  continue: boolean;
}

export interface TurnErrorContext {
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

export interface RunOptions {
  readonly turnId: number;
  readonly signal?: AbortSignal;
  /** Fires on the first model response event for a step, or at step completion. */
  readonly onStarted?: (step: number) => void;
}

export interface TurnResult {
  readonly reason: TurnEndReason;
  readonly error?: unknown;
  readonly steps?: number;
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;

  run(options: RunOptions): Promise<TurnResult>;

  readonly hooks: Hooks<{
    beforeStep: TurnBeforeStepContext;
    afterStep: TurnAfterStepContext;
    onError: TurnErrorContext;
  }>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
