/**
 * WorkflowTool — propose and start a dynamic workflow run.
 *
 * The model calls this tool either with the `name` of a saved workflow or
 * with an inline `script` it wrote for the user's task. The call is always a
 * proposal: the `workflow_run` display carries the full script, phases,
 * limits, and a consumption warning into the approval prompt, and the run
 * only starts after explicit user approval (see
 * `workflow-run-review-ask.ts`). Approved runs execute in the background via
 * the session's `WorkflowRunManager`, so the tool returns immediately with
 * the run/task ids instead of blocking the turn.
 */

import { z } from 'zod';

import type { Agent } from '../../../agent';
import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { extractWorkflowMeta } from '../../../workflow/script';
import {
  resolveWorkflowLimits,
  type WorkflowDefinition,
  type WorkflowLimits,
} from '../../../workflow/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { matchesGlobRuleSubject } from '../../support/rule-match';
import workflowDescriptionTemplate from './workflow.md?raw';

const WORKFLOW_CONSUMPTION_WARNING =
  'This workflow orchestrates multiple subagents and can consume significantly more tokens than a normal session.';

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
      'Name of a saved workflow to run (project, user, or builtin scope — e.g. "deep-research"). Provide exactly one of "name" or "script".',
    ),
  script: z
    .string()
    .optional()
    .describe(
      'Full text of a workflow script you wrote for the user\'s task. The first statement must be `export const meta = {...}`. Provide exactly one of "name" or "script".',
    ),
  args: z
    .string()
    .optional()
    .describe('Optional argument string delivered to the script as the `args` variable.'),
});

export class WorkflowTool implements BuiltinTool<WorkflowToolInput> {
  readonly name = 'Workflow';
  readonly description: string = renderPrompt(workflowDescriptionTemplate, {});
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WorkflowToolInputSchema);

  constructor(private readonly agent: Agent) {}

  async resolveExecution(input: WorkflowToolInput): Promise<ToolExecution> {
    if ((input.name === undefined) === (input.script === undefined)) {
      return {
        isError: true,
        output: 'Provide exactly one of "name" (saved workflow) or "script" (inline proposal).',
      };
    }
    const limits = resolveWorkflowLimits(this.agent.kimiConfig?.workflows);

    let definition: WorkflowDefinition;
    if (input.script !== undefined) {
      try {
        const meta = extractWorkflowMeta(input.script, { maxScriptBytes: limits.maxScriptBytes });
        definition = { meta, script: input.script, path: '', source: 'extra' };
      } catch (error) {
        return {
          isError: true,
          output: `Invalid workflow script: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      const registry = this.agent.workflows;
      if (registry === undefined) {
        return { isError: true, output: 'Workflow discovery is not available for this agent.' };
      }
      await registry.load();
      const found = registry.get(input.name!);
      if (found === undefined) {
        const available = registry
          .list()
          .map((workflow) => workflow.meta.name)
          .join(', ');
        return {
          isError: true,
          output: `Workflow "${input.name!}" not found.${available !== '' ? ` Available workflows: ${available}.` : ' No workflows are discoverable.'}`,
        };
      }
      definition = found;
    }

    const args = input.args ?? '';
    const meta = definition.meta;
    return {
      description: `Run workflow ${meta.name}`,
      display: {
        kind: 'workflow_run',
        workflow_name: meta.name,
        description: meta.description,
        when_to_use: meta.whenToUse,
        phases: meta.phases.map((phase) => ({ title: phase.title, detail: phase.detail })),
        args: args !== '' ? args : undefined,
        script: definition.script,
        source: input.script !== undefined ? 'inline' : definition.source,
        limits: {
          max_concurrency: limits.maxConcurrency,
          max_agent_calls: limits.maxAgentCalls,
          max_duration_ms: limits.maxDurationMs,
        },
        consumption_warning: WORKFLOW_CONSUMPTION_WARNING,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, meta.name),
      execute: () => this.execution(definition, args, limits),
    };
  }

  private execution(
    definition: WorkflowDefinition,
    args: string,
    limits: WorkflowLimits,
  ): Promise<ExecutableToolResult> {
    const runs = this.agent.workflowRuns;
    if (runs === undefined) {
      return Promise.resolve({
        isError: true,
        output: 'Workflow runs are not available for this agent.',
      });
    }
    const { runId, taskId } = runs.start(definition, { args, limits });
    return Promise.resolve({
      output:
        `Workflow "${definition.meta.name}" approved and started in the background ` +
        `(run id: ${runId}, task id: ${taskId}). The run does not block this turn: ` +
        `progress and the terminal status are delivered as background-task events, ` +
        `and the final result is the task output. Do not claim the run finished from ` +
        `this result — only that it started.`,
    });
  }
}
