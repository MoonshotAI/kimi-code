import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentInterruptionReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentInterruptionReminderService =
  createDecorator<IAgentInterruptionReminderService>('agentInterruptionReminderService');
