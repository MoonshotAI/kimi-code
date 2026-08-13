/**
 * `interruptionReminder` domain (L4) — user-interruption reminder contract.
 *
 * Defines the Agent-scoped aspect that records a model-visible reminder after
 * a user-cancelled turn. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentInterruptionReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentInterruptionReminderService =
  createDecorator<IAgentInterruptionReminderService>('agentInterruptionReminderService');
