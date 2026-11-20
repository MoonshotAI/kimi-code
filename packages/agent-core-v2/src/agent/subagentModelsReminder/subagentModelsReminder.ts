import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SubagentModelsDisclosure {
  readonly defaultModel?: string;
  readonly models: Readonly<Record<string, string>>;
}

export interface IAgentSubagentModelsReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentSubagentModelsReminderService: ServiceIdentifier<IAgentSubagentModelsReminderService> =
  createDecorator<IAgentSubagentModelsReminderService>('agentSubagentModelsReminderService');
