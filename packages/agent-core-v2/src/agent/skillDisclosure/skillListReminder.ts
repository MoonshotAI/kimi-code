/**
 * `skillDisclosure` domain (L4) — skill-list reminder contract.
 *
 * Defines the Agent-scoped marker service that announces structured skill
 * additions after the model's last committed disclosure baseline.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentSkillListReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentSkillListReminderService: ServiceIdentifier<IAgentSkillListReminderService> =
  createDecorator<IAgentSkillListReminderService>('agentSkillListReminderService');
