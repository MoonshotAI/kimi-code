import type { OsFsPort } from '#/features/os/host/index';
import type { PluginAgentRoot } from '../types';
import {
  discoverAgentFiles,
  PRIORITY,
  profilesFromDiscovery,
  type AgentProfileBasePrompt,
  type ProfileFinder,
} from '#/features/profiles/index';

export interface PluginProfileFinderDeps {
  readonly fs: OsFsPort;
  readonly agentRoots: () => Promise<readonly PluginAgentRoot[]>;
  readonly basePrompt: AgentProfileBasePrompt;
  readonly warn?: (message: string) => void;
}

export function createPluginProfileFinder(deps: PluginProfileFinderDeps): ProfileFinder {
  return {
    sourceId: 'plugin',
    priority: PRIORITY.plugin,
    load: async () =>
      profilesFromDiscovery(
        await discoverAgentFiles(deps.fs, await deps.agentRoots(), deps.warn),
        deps.basePrompt,
      ),
  };
}
