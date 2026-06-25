import { createDecorator } from '../../../di';

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface ISwarmMode {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  enter(trigger: SwarmModeTrigger): void;
  exit(): void;
}

declare module '../types' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }

}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISwarmMode = createDecorator<ISwarmMode>('agentSwarmModeService');
