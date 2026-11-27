import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentModeMutexService {
  readonly _serviceBrand: undefined;
  beforePlanEnter(): Promise<void>;
  beforeSwarmEnter(): void;
  beforeTowerEnter(): Promise<void>;
}

export const IAgentModeMutexService: ServiceIdentifier<IAgentModeMutexService> =
  createDecorator<IAgentModeMutexService>('agentModeMutexService');
