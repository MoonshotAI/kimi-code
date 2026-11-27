import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { LoadedAgentsMd } from '#/agent/profile/context';

export interface SubagentModelPoolSnapshot {
  readonly defaultModel?: string;
  readonly models: Readonly<Record<string, string>>;
}

export interface SubagentChangesInput {
  readonly previousSubagentNames?: readonly string[];
}

export interface BeliefsSeed {
  readonly agentsMd: string;
  readonly agentsMdPaths: readonly string[];
  readonly skillsListing: string;
}

export interface ReloadNotificationGuard {
  readonly previousSubagentNames: readonly string[];
  restoreAfterFailure(): Promise<void>;
}

export interface IAgentChangeNotifierService {
  readonly _serviceBrand: undefined;
  notifyAgentsMdChanges(): Promise<void>;
  notifySkillChanges(): Promise<void>;
  notifySubagentChanges(input?: SubagentChangesInput): Promise<void>;
  notifyWorkspaceDirsChanges(): Promise<void>;
  notifyAllChanges(input?: SubagentChangesInput): Promise<void>;
  prepareForReload(): ReloadNotificationGuard;
  seedBeliefs(seed: BeliefsSeed): Promise<void>;
  syncAgentsMdSnapshot(loaded: LoadedAgentsMd): Promise<void>;
  mute(): void;
  unmute(): void;
}

export const IAgentChangeNotifierService: ServiceIdentifier<IAgentChangeNotifierService> =
  createDecorator<IAgentChangeNotifierService>('agentChangeNotifierService');
