/**
 * `agentProfileCatalog` domain (L3) — the agent-profile Contribution shape and
 * source priorities.
 *
 * `AgentProfileContribution` is the Contribution of the agent-profile
 * extension point: the plain data structure a loader registers into the
 * App-scope `IAgentProfileRegistry` under its source id. It is pure payload —
 * the source id and priority are registration metadata passed to `register`,
 * never part of the contribution. Name-level dedup is NOT done here or in the
 * registry; it is the Session catalog's projection job. The shape lives beside
 * the registry (not beside any loader) because it is the registry's contract
 * with every contributor, whatever scope the contributor runs in.
 *
 * `AGENT_PROFILE_SOURCE_PRIORITY` orders the sources for that projection
 * (higher wins name collisions), with one deliberate deviation from the skill
 * system: `explicit` outranks every other source (in the skill system it
 * aliases `user`) because `--agent-file` is a one-shot command-line intent
 * that must always win.
 */

import type { AgentProfile } from './agentProfileCatalog';

/** A file a discovery pass could not parse, paired with the reason. */
export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
}

export interface AgentProfileContribution {
  readonly profiles: readonly AgentProfile[];
  readonly skipped?: readonly SkippedAgentFile[];
  readonly scannedRoots?: readonly string[];
}

export const AGENT_PROFILE_SOURCE_PRIORITY = {
  builtin: 0,
  plugin: 5,
  user: 10,
  extra: 20,
  workspace: 30,
  explicit: 40,
} as const;
