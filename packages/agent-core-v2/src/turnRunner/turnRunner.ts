import { createDecorator } from "#/_base/di";
import type { PromptOrigin } from '../../../agent/context';

import type { Hooks } from '../hooks';
import type { Turn, TurnEndedContext, TurnStepContext } from '../types';

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
