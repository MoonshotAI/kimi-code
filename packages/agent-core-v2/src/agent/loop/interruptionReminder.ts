/**
 * `loop` domain (L4) — user-interruption reminder contract.
 *
 * Defines the Agent-scoped aspect that records a model-visible reminder after
 * a user-cancelled turn. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentLoopInterruptionReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentLoopInterruptionReminderService =
  createDecorator<IAgentLoopInterruptionReminderService>('agentLoopInterruptionReminderService');
