/**
 * `profile` domain (L4) — `IAgentSkillListingReminderService` contract.
 *
 * Turn-boundary model notification for skill hot reload: the skill listing is
 * baked into the agent's system prompt at bind time, so after the session
 * skill catalog merges a filesystem- or config-driven reload the provider
 * registered by this service fires once at the agent's next new turn, appending
 * a system reminder with the refreshed `catalog.getModelSkillListing()` (whose
 * first line already supersedes earlier listings). Bound at Agent scope — each
 * agent carries its own pending flag.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const SKILL_CATALOG_CHANGED_INJECTION_VARIANT = 'skill_catalog_changed';

export interface IAgentSkillListingReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentSkillListingReminderService: ServiceIdentifier<IAgentSkillListingReminderService> =
  createDecorator<IAgentSkillListingReminderService>('agentSkillListingReminderService');
