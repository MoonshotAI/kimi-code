import { createDecorator } from "#/_base/di";
import type { ContextMessage, PromptOrigin } from '#/context';

import type { Hooks } from '#/hooks';


export interface TurnResult {
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'filtered';
  readonly error?: unknown;
}

export interface Turn {
  readonly id: number;
  readonly abortController: AbortController;
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface TurnStepContext {
  readonly turn: Turn;
  continueTurn: boolean;
}

export interface TurnRunContext {
  readonly turn: Turn;
  readonly origin: PromptOrigin;
  readonly promptMessage?: ContextMessage;
  result?: TurnResult;
}

export interface TurnEndedContext {
  readonly turn: Turn;
  readonly result: TurnResult;
}


export interface ITurnRunner {
  launch(origin: PromptOrigin): Turn;
  getActiveTurn(): Turn | undefined;
  cancel(turnId?: number, reason?: unknown): void;

  readonly hooks: Hooks<{
    onLaunched: { turn: Turn };
    onEnded: TurnEndedContext;
    beforeStep: TurnStepContext;
    afterStep: TurnStepContext;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITurnRunner = createDecorator<ITurnRunner>('agentTurnRunnerService');
