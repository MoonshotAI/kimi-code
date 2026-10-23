import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SubagentModelPoolSnapshot {
  readonly defaultModel?: string;
  readonly models: Readonly<Record<string, string>>;
}

export interface SubagentChangesInput {
  readonly previousSubagentNames?: readonly string[];
  readonly previousModelPool?: SubagentModelPoolSnapshot | null;
}

export interface BeliefsSeed {
  readonly agentsMd: string;
  readonly agentsMdPaths: readonly string[];
  readonly skillsListing: string;
}

export interface IAgentChangeNotifierService {
  readonly _serviceBrand: undefined;
  notifyAgentsMdChanges(): Promise<void>;
  notifySkillChanges(): Promise<void>;
  notifySubagentChanges(input?: SubagentChangesInput): Promise<void>;
  seedBeliefs(seed: BeliefsSeed): Promise<void>;
  mute(): void;
  unmute(): void;
}

export const IAgentChangeNotifierService: ServiceIdentifier<IAgentChangeNotifierService> =
  createDecorator<IAgentChangeNotifierService>('agentChangeNotifierService');
