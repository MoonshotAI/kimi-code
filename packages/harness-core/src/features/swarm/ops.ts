import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

export const SWARM_MODE_ENTER = 'swarm_mode.enter';
export const SWARM_MODE_EXIT = 'swarm_mode.exit';

export const SWARM_REMIND_KEY = 'swarm-mode';

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface SwarmModeState {
  readonly trigger: SwarmModeTrigger | null;
}

export const swarmModeProjection: Projection<SwarmModeState, RecordEvent, BranchRef> = {
  initial: () => ({ trigger: null }),
  reduce: (state, event) => {
    if (event.type === SWARM_MODE_ENTER) {
      return { trigger: event['trigger'] as SwarmModeTrigger };
    }
    if (event.type === SWARM_MODE_EXIT) {
      return { trigger: null };
    }
    return state;
  },
};
