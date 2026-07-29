/**
 * Agent-file model types: the parsed single-file definition
 * (`AgentFileDefinition`), scan roots (`AgentFileRoot`) tagged with their
 * source, and the discovery result carrying per-file skip diagnostics.
 * Pure data.
 *
 * Ported from the v2 engine (`packages/agent-core-v2/src/app/agentFileCatalog/types.ts`)
 * — keep the two in sync.
 */

import type { AgentModelPreference } from '../types';
import { z } from 'zod';

export type AgentFileSource = 'project' | 'user' | 'extra' | 'explicit';

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

export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
}

const AgentProfileSnapshotSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  tools: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  subagents: z.array(z.string()),
  modelPreference: z.enum(['primary', 'secondary']).optional(),
  prompt: z.string(),
});

/**
 * Normalized file-backed catalog state bound to a session. Unlike source
 * paths, this is sufficient to rebuild custom profiles after their files are
 * removed or changed: tool defaults and wildcard subagent sets are already
 * resolved to concrete lists.
 */
export const AgentProfileCatalogSnapshotSchema = z.object({
  version: z.literal(1),
  systemPromptTemplate: z.string().optional(),
  profiles: z.array(AgentProfileSnapshotSchema),
});

export type AgentProfileCatalogSnapshot = z.infer<typeof AgentProfileCatalogSnapshotSchema>;
