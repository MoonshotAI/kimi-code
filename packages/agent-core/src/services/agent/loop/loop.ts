import { createDecorator } from '../../../di';

import type { Turn, TurnResult, TurnStepContext } from '../types';

export interface LoopRunHook<TContext> {
  run(context: TContext): Promise<void>;
}

export interface LoopRunHooks {
  readonly beforeStep: LoopRunHook<TurnStepContext>;
  readonly afterStep: LoopRunHook<TurnStepContext>;
}

export interface ILoopService {
  runTurn(turn: Turn, hooks?: LoopRunHooks): Promise<TurnResult>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILoopService = createDecorator<ILoopService>('agentLoopService');
