import { z } from 'zod';

import {
  EnvironmentSetBinding,
  type WorkdirMoveBaseline,
} from '#/agent/environmentBinding/environmentBindingOps';
import { defineState } from '#/state/state';

export interface WorkdirMoveState {
  readonly originCwd?: string;
  readonly pendingBaseline?: WorkdirMoveBaseline;
}

export const workdirMoveStateKey = defineState(
  'workdirMove',
  (): WorkdirMoveState => ({}),
)
  .replayable({ schema: z.custom<WorkdirMoveState>() })
  .on(EnvironmentSetBinding, (state, event) => {
    if (event.originCwd === undefined && event.pendingBaseline === undefined) {
      return state;
    }
    return {
      originCwd:
        event.originCwd === null
          ? undefined
          : (event.originCwd ?? state.originCwd),
      pendingBaseline:
        event.pendingBaseline === null
          ? undefined
          : (event.pendingBaseline ?? state.pendingBaseline),
    };
  });
