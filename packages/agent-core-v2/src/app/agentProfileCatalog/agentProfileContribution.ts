/**
 * `agentProfileCatalog` domain — the agent-profile Contribution shape and
 * source priorities.
 *
 * `AgentProfileContribution` is the Contribution of the agent-profile
 * extension point: the plain data structure a loader contributes to the
 * `AgentProfileContribution` collection under its source id. It is pure
 * payload — the source id and priority are record metadata carried alongside
 * it, never part of the contribution. Name-level dedup is NOT done here or in
 * the registry fold; it is the Session catalog's projection job.
 *
 * `AGENT_PROFILE_SOURCE_PRIORITY` orders the sources for that projection
 * (higher wins name collisions), with one deliberate deviation from the skill
 * system: `explicit` outranks every other source (in the skill system it
 * aliases `user`) because `--agent-file` is a one-shot command-line intent
 * that must always win.
 */

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
