/**
 * `tools` domain (L7) — `WorkflowTool` implementation (the `Workflow` tool).
 *
 * The LLM-facing wrapper over the `workflow` domain: validates the
 * `name` xor `script` input, starts the run through the Session-scope
 * `IWorkflowRunService` (caller = the agent the tool runs in), and returns
 * immediately with the run / task ids — the run executes in the background as
 * a detached task on the caller's task service, so its completion arrives as
 * an automatic notification in a later turn. Each call carries a
 * `workflow_run` display (meta, phases, full script, resolved limits, and a
 * consumption warning) so the approval dialog can show exactly what will run.
 * The unconditional user review before any script runs is owned by the
 * `workflow` domain's Agent-scope
 * review listener (`agentWorkflowReview`), not by this tool. The public
 * contract (schema, constants, `IWorkflowTool`) lives in `./workflow`; the
 * description lists the workflows currently in the App-scope catalog.
 *
 * Registered via the module-level `registerAgentToolService(IWorkflowTool,
 * WorkflowTool)` at the bottom of this file, gated by the `dynamic-workflows`
 * experimental flag through the contribution's `when` predicate. Bound at
 * Agent scope.
 */

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { WORKFLOWS_SECTION, type WorkflowsConfig } from '#/app/workflow/configSection';
import { DYNAMIC_WORKFLOWS_FLAG_ID } from '#/app/workflow/flag';
import { extractWorkflowMeta } from '#/app/workflow/runtime/script';
import {
  resolveWorkflowLimits,
  type WorkflowLimits,
  type WorkflowMeta,
} from '#/app/workflow/runtime/types';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { IWorkflowRunService } from '#/session/workflow/sessionWorkflowRun';

import {
  IWorkflowTool,
  WORKFLOW_NAME_OR_SCRIPT_REQUIRED,
  WorkflowToolInputSchema,
  type WorkflowToolInput,
} from './workflow';

import WORKFLOW_DESCRIPTION from './workflow.md?raw';

export class WorkflowTool implements IWorkflowTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = WORKFLOW_TOOL_NAME;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WorkflowToolInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @IWorkflowRunService private readonly runs: IWorkflowRunService,
    @IWorkflowCatalogService private readonly catalog: IWorkflowCatalogService,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    const lines = this.catalog
      .list()
      .map(
        (workflow) =>
          `- ${workflow.meta.name} (${workflow.source}): ${workflow.meta.description}`,
      );
    if (lines.length === 0) return WORKFLOW_DESCRIPTION;
    return `${WORKFLOW_DESCRIPTION}\n\nAvailable workflows (pass via name):\n${lines.join('\n')}`;
  }

  resolveExecution(args: WorkflowToolInput): ToolExecution {
    const name = args.name?.trim();
    const hasName = name !== undefined && name.length > 0;
    const script = args.script?.trim();
    const hasScript = script !== undefined && script.length > 0;
    if (hasName === hasScript) {
      return { output: WORKFLOW_NAME_OR_SCRIPT_REQUIRED, isError: true };
    }
    const subject = hasName ? name! : 'inline-script';
    return {
      description: hasName ? `Run workflow ${subject}` : 'Run inline workflow script',
      accesses: ToolAccesses.none(),
      display: hasName
        ? this.namedWorkflowDisplay(name!, args.args ?? '')
        : this.inlineScriptDisplay(script!, args.args ?? ''),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: (ctx) => this.execution(args, ctx.signal),
    };
  }

  private namedWorkflowDisplay(name: string, args: string): ToolInputDisplay {
    const definition = this.catalog.get(name);
    if (definition === undefined) {
      return { kind: 'generic', summary: `Run workflow "${name}"`, detail: args };
    }
    return workflowRunDisplay(definition.meta, definition.script, definition.source, args, this.limits());
  }

  private inlineScriptDisplay(script: string, args: string): ToolInputDisplay {
    const limits = this.limits();
    try {
      const meta = extractWorkflowMeta(script, { maxScriptBytes: limits.maxScriptBytes });
      return workflowRunDisplay(meta, script, 'inline', args, limits);
    } catch {
      return { kind: 'generic', summary: 'Run inline workflow script', detail: script };
    }
  }

  private limits(): WorkflowLimits {
    return resolveWorkflowLimits(this.config.get<WorkflowsConfig>(WORKFLOWS_SECTION));
  }

  private async execution(
    args: WorkflowToolInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      if (!this.flags.enabled(DYNAMIC_WORKFLOWS_FLAG_ID)) {
        return {
          output:
            'Dynamic workflows are experimental and currently disabled. Enable the dynamic-workflows experiment to use this tool.',
          isError: true,
        };
      }
      const name = args.name?.trim();
      const { runId, taskId } = await this.runs.start({
        name: name !== undefined && name.length > 0 ? name : undefined,
        script: args.script,
        args: args.args ?? '',
        callerAgentId: this.callerAgentId,
      });
      return {
        output: [
          `run_id: ${runId}`,
          `task_id: ${taskId}`,
          'status: running',
          'automatic_notification: true',
          '',
          'next_step: The workflow runs in the background and its completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user.',
        ].join('\n'),
      };
    } catch (error) {
      return {
        output: `workflow error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}

registerAgentToolService(IWorkflowTool, WorkflowTool, {
  name: WORKFLOW_TOOL_NAME,
  domain: 'workflow',
  when: (accessor) => accessor.get(IFlagService).enabled(DYNAMIC_WORKFLOWS_FLAG_ID),
});

function workflowRunDisplay(
  meta: WorkflowMeta,
  script: string,
  source: string,
  args: string,
  limits: WorkflowLimits,
): ToolInputDisplay {
  const minutes = Math.round(limits.maxDurationMs / 60_000);
  return {
    kind: 'workflow_run',
    workflow_name: meta.name,
    description: meta.description,
    when_to_use: meta.whenToUse,
    phases: meta.phases,
    args,
    script,
    source,
    limits: {
      max_concurrency: limits.maxConcurrency,
      max_agent_calls: limits.maxAgentCalls,
      max_duration_ms: limits.maxDurationMs,
    },
    consumption_warning: `This workflow may make up to ${limits.maxAgentCalls} subagent LLM calls and run for up to ${minutes} minutes, consuming significant tokens.`,
  };
}
