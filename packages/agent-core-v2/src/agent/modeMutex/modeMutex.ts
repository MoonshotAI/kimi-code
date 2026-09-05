import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentModeMutexService {
  readonly _serviceBrand: undefined;
}

export const IAgentModeMutexService: ServiceIdentifier<IAgentModeMutexService> =
  createDecorator<IAgentModeMutexService>('agentModeMutexService');
