import type { Environment } from '@moonshot-ai/kaos';
import { z } from 'zod';

import type { SkillRegistry } from '../skill';

export const RawSubagentProfileSchema = z.object({
  description: z.string().optional(),
});

export type RawSubagentProfile = z.infer<typeof RawSubagentProfileSchema>;

export const RawAgentProfileSchema = z.object({
  extends: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPromptPath: z.string().optional(),
  systemPromptTemplate: z.string().optional(),
  promptVars: z.record(z.string(), z.string()).optional(),
  // Exact builtin/user tool names, plus optional MCP glob patterns
  // (`mcp__*`, `mcp__github__*`) that gate which MCP tools the profile sees.
  tools: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  subagents: z.record(z.string(), RawSubagentProfileSchema).optional(),
});

export type RawAgentProfile = z.infer<typeof RawAgentProfileSchema>;

/**
 * Runtime context supplied to a system prompt renderer.
 *
 * Captures everything determined at render time rather than at profile-load
 * time: the OS/shell, working directory, AGENTS.md instructions, available
 * skills, and so on. Loaders return renderers; callers invoke them with
 * the live context whenever a concrete prompt is needed.
 */
export interface SystemPromptContext {
  readonly osEnv: Environment;
  readonly cwd: string;
  readonly now?: string | Date;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly skills?: SkillRegistry | string;
  readonly additionalDirsInfo?: string;
  readonly roleAdditional?: string;
}

export type SystemPromptRenderer = (context: SystemPromptContext) => string;

export interface ResolvedAgentProfile {
  name: string;
  description?: string;
  systemPrompt: SystemPromptRenderer;
  tools: string[];
  whenToUse?: string;
  subagents?: Record<string, ResolvedAgentProfile>;
}
