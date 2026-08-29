import { collection } from '#/_base/di/collection';
import type { AgentProfile } from './agentProfileCatalog';

export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
}

export interface AgentProfileContribution {
  readonly profiles: readonly AgentProfile[];
  readonly skipped?: readonly SkippedAgentFile[];
  readonly scannedRoots?: readonly string[];
}

export interface AgentProfileContributionRecord {
  readonly sourceId: string;
  readonly priority?: number;
  readonly workspaceKey?: string;
  readonly contribution: AgentProfileContribution;
}

export const AgentProfileContribution = collection<AgentProfileContributionRecord>('agent-profile');

export const AGENT_PROFILE_SOURCE_PRIORITY = {
  builtin: 0,
  plugin: 5,
  user: 10,
  extra: 20,
  workspace: 30,
  explicit: 40,
} as const;
