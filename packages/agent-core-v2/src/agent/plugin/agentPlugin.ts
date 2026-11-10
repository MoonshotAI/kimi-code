import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentPluginService {
  readonly _serviceBrand: undefined;

  refreshSessionStart(): Promise<void>;
}

export const IAgentPluginService: ServiceIdentifier<IAgentPluginService> =
  createDecorator<IAgentPluginService>('agentPluginService');
