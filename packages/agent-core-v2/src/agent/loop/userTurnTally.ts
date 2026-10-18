import { z } from 'zod';

import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { isUserTurnOrigin, type ContextMessage } from '#/agent/contextMemory/types';
import type { IAgentStateService } from '#/agent/state/agentState';
import { defineState } from '#/state/state';

import { TurnPrompt } from './turnOps';

export interface UserTurnTally {
  readonly count: number;
  readonly reliable: boolean;
  readonly promptSeen: boolean;
}

function isUntrackedUserMessage(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin: unknown = message.origin;
  return origin === undefined || origin === null || isRealUserInput(message);
}

export const userTurnTallyKey = defineState(
  'userTurnTally',
  (): UserTurnTally => ({ count: 0, reliable: true, promptSeen: false }),
)
  .replayable({ schema: z.custom<UserTurnTally>() })
  .on(TurnPrompt, (s, e) => {
    const userTurn = isUserTurnOrigin(e.origin);
    return {
      count: userTurn === true ? s.count + 1 : s.count,
      reliable: s.reliable && userTurn !== undefined,
      promptSeen: true,
    };
  })
  .on(ContextAppendMessage, (s, e) => {
    if (s.promptSeen || !s.reliable || !isUntrackedUserMessage(e.message)) return;
    return { ...s, reliable: false };
  });

export function readSessionUserTurnCount(states: IAgentStateService): number | undefined {
  if (!states.has(userTurnTallyKey)) return undefined;
  const tally = states.get(userTurnTallyKey);
  return tally.reliable ? tally.count : undefined;
}
