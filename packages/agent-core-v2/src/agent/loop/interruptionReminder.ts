import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentLoopInterruptionReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentLoopInterruptionReminderService =
  createDecorator<IAgentLoopInterruptionReminderService>('agentLoopInterruptionReminderService');
