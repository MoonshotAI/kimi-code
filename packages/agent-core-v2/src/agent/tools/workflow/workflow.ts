/**
 * `tools` domain (L7) — `IWorkflowTool` contract (the `Workflow` tool).
 *
 * Public contract of the experimental `Workflow` tool that lets the LLM start
 * a Dynamic Workflow run by catalog `name` or inline `script`: the
 * model-facing `WorkflowToolInputSchema` / `WorkflowToolInput`, and the
 * `IWorkflowTool` DI decorator that the implementation (`workflowTool.ts`)
 * registers against via `registerAgentToolService`, gated by the
 * `dynamic-workflows` experimental flag. The shared tool-name constant lives
 * in the owning `workflow` domain (`WORKFLOW_TOOL_NAME`). Bound at Agent
 * scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export interface WorkflowToolInput {
  name?: string;
  script?: string;
  args?: string;
}

export const WorkflowToolInputSchema: z.ZodType<WorkflowToolInput> = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'The exact name of a catalog workflow (e.g. "deep-research"), spelled as it appears in the workflow listing. Mutually exclusive with `script`.',
    ),
  script: z
    .string()
    .optional()
    .describe(
      'A full inline workflow script: `export const meta = {...}` followed by the body using the sandbox API (args, phase(), log(), agent(), parallel(), pipeline()) with top-level await and a top-level return. Mutually exclusive with `name`.',
    ),
  args: z
    .string()
    .optional()
    .describe(
      'Argument string handed to the workflow as its `args` value (e.g. the research question for deep-research).',
    ),
});

export const WORKFLOW_NAME_OR_SCRIPT_REQUIRED =
  'Workflow requires exactly one of name (a catalog workflow) or script (an inline workflow script).';

export interface IWorkflowTool extends AgentTool<WorkflowToolInput> {
  readonly _serviceBrand: undefined;
}
export const IWorkflowTool = createDecorator<IWorkflowTool>('workflowTool');
