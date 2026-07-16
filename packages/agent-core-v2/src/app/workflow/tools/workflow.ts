/**
 * WorkflowTool — model-facing tool for running orchestrated agent workflows.
 *
 * Supports `run`, `status`, `wait`, and `cancel` operations. Workflows
 * run in the background — `run` returns immediately with a run ID, and
 * the result arrives as a terminal notification when the workflow completes.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { IWorkflowService } from '#/app/workflow/workflowService';
import { getBuiltin, resolveUserWorkflow } from '#/app/workflow/workflowRegistry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import DESCRIPTION from './workflow.md?raw';

const WorkflowOperationSchema = z.enum(['run', 'status', 'wait', 'cancel']);

export const WorkflowToolInputSchema = z
  .object({
    operation: WorkflowOperationSchema.describe('The workflow operation to perform.'),
    name: z
      .string()
      .optional()
      .describe('Built-in or user workflow name (for `run`). Mutually exclusive with `script`.'),
    script: z
      .string()
      .optional()
      .describe('Inline workflow script (for `run`). Mutually exclusive with `name`.'),
    args: z
      .string()
      .optional()
      .describe('Arguments to pass to the workflow (for `run`).'),
    run_id: z
      .string()
      .optional()
      .describe('Workflow run ID (for `status`, `wait`, `cancel`).'),
    timeout_ms: z
      .number()
      .optional()
      .describe('Timeout in milliseconds (for `wait`).'),
  })
  .strict();

export type WorkflowToolInput = z.infer<typeof WorkflowToolInputSchema>;

export class WorkflowTool implements BuiltinTool<WorkflowToolInput> {
  readonly name = 'Workflow' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WorkflowToolInputSchema);

  constructor(
    @IWorkflowService private readonly workflow: IWorkflowService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: WorkflowToolInput): ToolExecution {
    return {
      description: `Workflow: ${args.operation}`,
      approvalRule: this.name,
      execute: async () => {
        switch (args.operation) {
          case 'run':
            return this.handleRun(args);
          case 'status':
            return this.handleStatus(args);
          case 'wait':
            return this.handleWait(args);
          case 'cancel':
            return this.handleCancel(args);
          default:
            return { output: `Unknown workflow operation: ${args.operation}`, isError: true };
        }
      },
    };
  }

  private async handleRun(args: WorkflowToolInput) {
    if (!args.name && !args.script) {
      return { output: 'Either `name` or `script` is required for `run`.', isError: true };
    }
    if (args.name && args.script) {
      return { output: '`name` and `script` are mutually exclusive.', isError: true };
    }

    let script: string;
    let workflowName: string;

    if (args.name) {
      // Try built-in first, then user workflow.
      const builtin = getBuiltin(args.name);
      if (builtin) {
        script = builtin.script;
        workflowName = builtin.meta.name;
      } else {
        const userWf = await resolveUserWorkflow(this.bootstrap.homeDir, args.name);
        if (userWf === undefined) {
          return { output: `Workflow not found: ${args.name}`, isError: true };
        }
        script = userWf.script;
        workflowName = userWf.meta.name;
      }
    } else {
      script = args.script!;
      workflowName = 'inline';
    }

    const { runId } = await this.workflow.start({
      script,
      args: args.args,
      callerAgentId: this.scopeContext.agentId,
      sessionContext: this.sessionContext,
      lifecycle: this.lifecycle,
      subagents: this.subagents,
    });

    return {
      output: `Workflow "${workflowName}" started. run_id: ${runId}\nThe result will be delivered as a notification when complete.\nUse Workflow({ operation: "status", run_id: "${runId}" }) to check progress.`,
    };
  }

  private async handleStatus(args: WorkflowToolInput) {
    if (!args.run_id) {
      return { output: '`run_id` is required for `status`.', isError: true };
    }
    const result = this.workflow.status(args.run_id);
    if (result === undefined) {
      return { output: `Workflow run not found: ${args.run_id}` };
    }
    return { output: formatStatus(result) };
  }

  private async handleWait(args: WorkflowToolInput) {
    if (!args.run_id) {
      return { output: '`run_id` is required for `wait`.', isError: true };
    }
    const result = await this.workflow.wait(args.run_id, args.timeout_ms);
    if (result === undefined) {
      return { output: `Workflow run not found: ${args.run_id}` };
    }
    if (result.status === 'completed') {
      const resultStr = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);
      return {
        output: `Workflow completed.\nAgent runs: ${result.agentCount}\nDuration: ${((result.finishedAt ?? 0) - result.startedAt) / 1000}s\n\nResult:\n${resultStr}`,
        stopTurn: true,
      };
    }
    return { output: formatStatus(result) };
  }

  private async handleCancel(args: WorkflowToolInput) {
    if (!args.run_id) {
      return { output: '`run_id` is required for `cancel`.', isError: true };
    }
    await this.workflow.cancel(args.run_id);
    return { output: `Workflow cancelled: ${args.run_id}` };
  }
}

function formatStatus(result: {
  runId: string;
  status: string;
  currentPhase?: string;
  agentCount: number;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}): string {
  const elapsed = ((result.finishedAt ?? Date.now()) - result.startedAt) / 1000;
  const lines = [
    `run_id: ${result.runId}`,
    `status: ${result.status}`,
    `agents: ${result.agentCount}`,
    `elapsed: ${elapsed.toFixed(1)}s`,
  ];
  if (result.currentPhase) lines.push(`phase: ${result.currentPhase}`);
  if (result.error) lines.push(`error: ${result.error}`);
  return lines.join('\n');
}

registerTool(WorkflowTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
