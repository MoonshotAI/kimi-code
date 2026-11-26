import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { NormalizedSubagentModelEntry } from '#/session/subagent/configSection';

export interface SubagentModelsDisclosure {
  readonly defaultModel?: string;
  readonly allModels?: boolean;
  readonly rule?: string;
  readonly models: Readonly<Record<string, NormalizedSubagentModelEntry>>;
}

export interface IAgentSubagentModelsReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentSubagentModelsReminderService: ServiceIdentifier<IAgentSubagentModelsReminderService> =
  createDecorator<IAgentSubagentModelsReminderService>('agentSubagentModelsReminderService');
