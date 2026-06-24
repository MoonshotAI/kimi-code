import { createDecorator } from '../../../di';

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface ISwarmMode {
  readonly _serviceBrand: undefined;
  readonly active: SwarmModeTrigger | null;
  readonly isActive: boolean;
  readonly shouldAutoExit: boolean;
  enter(trigger: SwarmModeTrigger): void;
  exit(): void;
  restoreEnter(trigger: SwarmModeTrigger): void;
  data(): boolean;
}

declare module '../types' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }

  interface AgentEventMap {
    'swarm_mode.changed': {
      active: SwarmModeTrigger | null;
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISwarmMode = createDecorator<ISwarmMode>('agentSwarmModeService');
