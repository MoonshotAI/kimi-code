/**
 * `agentFileCatalog` domain (L3) — agent-profile source contract.
 *
 * `IAgentProfileSource` is the producer half of the agent-file subsystem: each
 * source loads an `AgentProfileContribution` and advertises a `priority` so the
 * Session catalog can ordered-merge contributions (higher priority wins name
 * collisions). Mirrors `skillCatalog/skillSource`, with one deliberate
 * deviation: `explicit` outranks every other source (in the skill system it
 * aliases `user`) because `--agent-file` is a one-shot command-line intent that
 * must always win. Concrete sources (user at App scope; project / extra /
 * explicit at Session scope) each bind their own DI token extending this
 * contract.
 */

import type { Event } from '#/_base/event';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

import { agentProfileFromFile } from './agentProfileFromFile';
import type { AgentFileDiscoveryResult, SkippedAgentFile } from './types';

export interface AgentProfileContribution {
  readonly profiles: readonly AgentProfile[];
  readonly skipped?: readonly SkippedAgentFile[];
  readonly scannedRoots?: readonly string[];
}

export const AGENT_PROFILE_SOURCE_PRIORITY = {
  user: 10,
  extra: 20,
  project: 30,
  explicit: 40,
} as const;

export interface IAgentProfileSource {
  readonly _serviceBrand: undefined;
  readonly id: string;
  readonly priority: number;
  readonly onDidChange?: Event<void>;
  /**
   * When true, a `load()` rejection is fatal: the Session catalog lets it
   * propagate into `ready` so awaiters see the error. When unset, the catalog
   * degrades to a warning and keeps any previously loaded contribution —
   * directory sources must never poison a session over a transient fs error.
   * `explicit` sets this because `--agent-file` is an explicit user intent
   * that must not be silently dropped.
   */
  readonly fatal?: boolean;
  load(): Promise<AgentProfileContribution>;
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
): AgentProfileContribution {
  return {
    profiles: result.agents.map(agentProfileFromFile),
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
  };
}
