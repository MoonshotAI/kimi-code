/**
 * `toolSelect` domain (L4) — `IAgentToolSelectAnnouncementsService` contract.
 *
 * Defines the Agent-scope marker service that appends v1-compatible
 * loadable-tools announcements through `systemReminder` at loop boundaries.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentToolSelectAnnouncementsService {
  readonly _serviceBrand: undefined;
}

export const IAgentToolSelectAnnouncementsService: ServiceIdentifier<IAgentToolSelectAnnouncementsService> =
  createDecorator<IAgentToolSelectAnnouncementsService>('agentToolSelectAnnouncementsService');
