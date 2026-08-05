/**
 * `agentProfileCatalog` domain — `IBuiltinAgentProfileLoader` contract.
 *
 * The builtin loader of the agent-profile extension point: owns the global
 * `builtin` contribution (priority 0) in the App-scope `IAgentProfileRegistry`
 * — the code-defined profiles accumulated at module load via
 * `registerAgentProfile(...)`. Also exposes the static `get` / `getDefault` /
 * `list` read view for loader-time consumers that need the builtin default
 * before any session catalog exists. App-scoped.
 */

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
