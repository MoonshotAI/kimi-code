import { createDecorator } from "#/_base/di/instantiation";

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface IAgentSwarmService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: SwarmModeTrigger): void;
  exit(): void;
}

export const IAgentSwarmService = createDecorator<IAgentSwarmService>('agentSwarmService');
