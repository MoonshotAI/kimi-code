import { createDecorator } from "#/_base/di/instantiation";
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

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;

  launch(origin?: PromptOrigin): Turn;
  getActiveTurn(): Turn | undefined;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
