/**
 * `toolSelect` domain — `IAgentToolSelectAnnouncementsService` contract.
 *
 * Defines the Agent-scope marker service that announces v1-compatible
 * loadable-tools diffs through the `contextInjector` boundary scheduler.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentToolSelectAnnouncementsService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolSelectAnnouncementsService: ServiceIdentifier<IAgentToolSelectAnnouncementsService> =
  createDecorator<IAgentToolSelectAnnouncementsService>('agentToolSelectAnnouncementsService');
