/**
 * `workflow` domain (L6) — workflow config section.
 *
 * Owns the `[workflows]` configuration section consumed by the workflow
 * catalog (extra discovery roots, script size ceiling) and the run service
 * (concurrency / agent-call / duration limits). Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const WORKFLOWS_SECTION = 'workflows';

export const WorkflowsConfigSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  maxAgentCalls: z.number().int().min(1).optional(),
  maxDurationMs: z.number().int().min(1000).optional(),
  maxScriptBytes: z.number().int().min(1024).optional(),
  extraWorkflowDirs: z.array(z.string()).optional(),
});

export type WorkflowsConfig = z.infer<typeof WorkflowsConfigSchema>;

export const DEFAULT_WORKFLOWS_CONFIG: Required<WorkflowsConfig> = {
  maxConcurrency: 4,
  maxAgentCalls: 50,
  maxDurationMs: 30 * 60_000,
  maxScriptBytes: 256 * 1024,
  extraWorkflowDirs: [],
};

registerConfigSection(WORKFLOWS_SECTION, WorkflowsConfigSchema, {
  defaultValue: DEFAULT_WORKFLOWS_CONFIG,
});
