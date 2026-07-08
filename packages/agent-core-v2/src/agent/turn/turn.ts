import { createDecorator } from "#/_base/di/instantiation";
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { LoopRunResult } from '#/agent/loop/loop';

export type { LoopRunResult as TurnResult } from '#/agent/loop/loop';

export interface Turn {
  readonly id: number;
  readonly abortController: AbortController;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<LoopRunResult>;
}

export interface TurnPromptInfo {
  readonly input?: unknown;
  readonly origin?: PromptOrigin;
  readonly steer?: unknown;
}

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;

  launch(prompt?: TurnPromptInfo): Turn;
  recordSteer(input: readonly ContentPart[], origin?: PromptOrigin): void;
  cancel(turnId?: number, reason?: unknown): boolean;
  getActiveTurn(): Turn | undefined;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
