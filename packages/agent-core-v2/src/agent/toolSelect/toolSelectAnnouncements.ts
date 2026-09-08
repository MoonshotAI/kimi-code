import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentToolSelectAnnouncementsService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolSelectAnnouncementsService: ServiceIdentifier<IAgentToolSelectAnnouncementsService> =
  createDecorator<IAgentToolSelectAnnouncementsService>('agentToolSelectAnnouncementsService');
