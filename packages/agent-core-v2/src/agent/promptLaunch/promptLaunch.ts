import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentPromptLaunchService {
  readonly _serviceBrand: undefined;
}

export const IAgentPromptLaunchService: ServiceIdentifier<IAgentPromptLaunchService> =
  createDecorator<IAgentPromptLaunchService>('agentPromptLaunchService');
