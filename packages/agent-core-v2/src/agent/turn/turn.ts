import { createDecorator } from "#/_base/di";
import type { TurnResult } from '#/agent/loop';
import type { Hooks } from '#/hooks';

export type { TurnResult } from '#/agent/loop';

export interface Turn {
  readonly id: number;
  readonly abortController: AbortController;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;

  launch(): Turn;
  getActiveTurn(): Turn | undefined;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
