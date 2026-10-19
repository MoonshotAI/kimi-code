import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentToolActivationService {
  readonly _serviceBrand: undefined;

  activate(): Promise<void>;
}

export const IAgentToolActivationService =
  createDecorator<IAgentToolActivationService>('agentToolActivationService');
