import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface MediaCapabilityDisclosure {
  readonly imageIn: boolean;
  readonly videoIn: boolean;
}

export interface IAgentMediaCapabilityReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentMediaCapabilityReminderService: ServiceIdentifier<IAgentMediaCapabilityReminderService> =
  createDecorator<IAgentMediaCapabilityReminderService>('agentMediaCapabilityReminderService');
