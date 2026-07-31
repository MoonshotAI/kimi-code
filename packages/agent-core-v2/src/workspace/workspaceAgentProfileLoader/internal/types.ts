/**
 * `workspaceAgentProfileLoader` domain (L3) — agent-file model types.
 *
 * Shared types for the agent-file primitives: the parsed single-file
 * definition (`AgentFileDefinition`), scan roots (`AgentFileRoot`) tagged with
 * their source, and the discovery result carrying per-file skip diagnostics.
 * Pure data; no scoped state.
 */

import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

export interface AgentFileRoot {
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly override: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentModelPreference;
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}
