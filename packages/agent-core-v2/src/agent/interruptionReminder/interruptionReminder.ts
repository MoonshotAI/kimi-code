import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentInterruptionReminderService {
  readonly _serviceBrand: undefined;
  notifyUserCancellation(reason: unknown): void;
}

export const IAgentInterruptionReminderService =
  createDecorator<IAgentInterruptionReminderService>('agentInterruptionReminderService');
