import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SubagentChangesInput {
  readonly previousSubagentNames?: readonly string[];
  readonly previousModelPoolAliases?: readonly string[];
}

export interface IAgentChangeNotifierService {
  readonly _serviceBrand: undefined;
  notifyAgentsMdChanges(): Promise<void>;
  notifySkillChanges(): Promise<void>;
  notifySubagentChanges(input?: SubagentChangesInput): Promise<void>;
}

export const IAgentChangeNotifierService: ServiceIdentifier<IAgentChangeNotifierService> =
  createDecorator<IAgentChangeNotifierService>('agentChangeNotifierService');
