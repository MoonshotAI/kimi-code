import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { AgentProfile } from './agentProfileCatalog';

export const BUILTIN_AGENT_PROFILE_SOURCE_ID = 'builtin';

export interface IBuiltinAgentProfileLoader {
  readonly _serviceBrand: undefined;

  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
}

export const IBuiltinAgentProfileLoader: ServiceIdentifier<IBuiltinAgentProfileLoader> =
  createDecorator<IBuiltinAgentProfileLoader>('builtinAgentProfileLoader');
