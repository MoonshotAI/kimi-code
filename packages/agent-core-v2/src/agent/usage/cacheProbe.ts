import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentCacheProbeService {
  readonly _serviceBrand: undefined;
}

export const IAgentCacheProbeService: ServiceIdentifier<IAgentCacheProbeService> =
  createDecorator<IAgentCacheProbeService>('agentCacheProbeService');
