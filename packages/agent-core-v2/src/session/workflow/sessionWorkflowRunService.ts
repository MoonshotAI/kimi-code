/**
 * `workflow` domain (L6) — `IWorkflowRunService` implementation.
 *
 * Starts workflow runs as detached background tasks on the caller agent's
 * task service (borrowed through the `agentLifecycle` scope handle — the same
 * cross-scope borrow the swarm uses for child accessors), tracks the per-run
 * record in memory, and publishes the `workflow.run.*` facts on the caller
 * agent's event bus (the bus is Agent-scoped, so it is borrowed through the
 * caller handle rather than injected). The sandbox execution itself lives in
 * the engine-agnostic runtime; the subagent host is built per run over
 * `agentLifecycle.create` + `subagent.run` with the `Agent` tool's default
 * profile and binding resolution. Limits come from the `workflows` config
 * section; definitions come from the `workflow` catalog (App) or an inline
 * script. Bound at Session scope.
 */

import { randomBytes } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import {
  type IAgentScopeHandle,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskSink } from '#/agent/task/types';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { WORKFLOWS_SECTION, type WorkflowsConfig } from '#/app/workflow/configSection';
import { extractWorkflowMeta } from '#/app/workflow/runtime/script';
import { runWorkflowScript } from '#/app/workflow/runtime/runtime';
import {
  resolveWorkflowLimits,
  type WorkflowDefinition,
  type WorkflowLimits,
} from '#/app/workflow/runtime/types';
import { WorkflowValidationError } from '#/app/workflow/runtime/validate';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  IWorkflowRunService,
  type StartWorkflowRunInput,
  type WorkflowRunAgentCallEvent,
  type WorkflowRunCompletedEvent,
  type WorkflowRunLogEvent,
  type WorkflowRunPhaseEvent,
  type WorkflowRunRecord,
  type WorkflowRunStartedEvent,
} from './sessionWorkflowRun';
import { SubagentWorkflowHost } from './workflowHost';
import { WorkflowRunTask } from './workflowRunTask';

const MAX_RUN_LOGS = 200;

type WorkflowRunBusEvent =
  | WorkflowRunStartedEvent
  | WorkflowRunPhaseEvent
  | WorkflowRunLogEvent
  | WorkflowRunAgentCallEvent
  | WorkflowRunCompletedEvent;

export class WorkflowRunService extends Disposable implements IWorkflowRunService {
  declare readonly _serviceBrand: undefined;

  private readonly runs = new Map<string, WorkflowRunRecord>();

  constructor(
    @IWorkflowCatalogService private readonly catalog: IWorkflowCatalogService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly profiles: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  async start(
    input: StartWorkflowRunInput,
  ): Promise<{ readonly runId: string; readonly taskId: string }> {
    const definition = await this.resolveDefinition(input);
    const caller = this.lifecycle.get(input.callerAgentId);
    if (caller === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${input.callerAgentId}" does not exist`, {
        details: { agentId: input.callerAgentId },
      });
    }
    const limits = this.limits();

    const runId = generateRunId();
    const record: WorkflowRunRecord = {
      runId,
      workflowName: definition.meta.name,
      description: definition.meta.description,
      phases: [...definition.meta.phases],
      status: 'running',
      agentCalls: 0,
      logs: [],
      startedAt: Date.now(),
      scriptPath: definition.path !== '' ? definition.path : undefined,
      source: definition.source,
      script: definition.script,
      args: input.args,
      callerAgentId: input.callerAgentId,
    };
    this.runs.set(runId, record);

    const host = new SubagentWorkflowHost({
      caller,
      runId,
      lifecycle: this.lifecycle,
      subagents: this.subagents,
      catalog: this.profiles,
      config: this.config,
      flags: this.flags,
      modelCatalog: this.modelCatalog,
      sessionContext: this.sessionContext,
      processRunner: this.processRunner,
      log: this.log,
    });
    const task = new WorkflowRunTask(
      `Workflow: ${definition.meta.name}`,
      (sink) => this.runToCompletion(record, definition, host, caller, input.args, limits, sink),
      () => ({
        runId,
        workflowName: record.workflowName,
        phase: record.phase,
        phases: record.phases,
        phaseIndex: record.phaseIndex,
        agentCalls: record.agentCalls,
      }),
    );

    let taskId: string;
    try {
      taskId = caller.accessor
        .get(IAgentTaskService)
        .registerTask(task, { detached: true, timeoutMs: 0 });
    } catch (error) {
      this.runs.delete(runId);
      throw error;
    }
    record.taskId = taskId;

    this.publish(caller, {
      type: 'workflow.run.started',
      sessionId: this.sessionContext.sessionId,
      runId,
      taskId,
      workflowName: record.workflowName,
      description: record.description,
      phases: record.phases,
    });
    return { runId, taskId };
  }

  list(): WorkflowRunRecord[] {
    return [...this.runs.values()];
  }

  get(runId: string): WorkflowRunRecord | undefined {
    return this.runs.get(runId);
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (record === undefined || record.taskId === undefined) return false;
    if (record.status !== 'running') return false;
    const caller = this.lifecycle.get(record.callerAgentId);
    if (caller === undefined) return false;
    void caller.accessor
      .get(IAgentTaskService)
      .stop(record.taskId, 'Workflow run cancelled')
      .catch(() => {});
    return true;
  }

  private async resolveDefinition(input: StartWorkflowRunInput): Promise<WorkflowDefinition> {
    const name = input.name !== undefined && input.name.length > 0 ? input.name : undefined;
    const script = input.script !== undefined && input.script.length > 0 ? input.script : undefined;
    if ((name !== undefined) === (script !== undefined)) {
      throw new Error2(
        ErrorCodes.WORKFLOW_INVALID,
        'workflow run requires exactly one of name or script',
      );
    }
    if (name !== undefined) {
      await this.catalog.ready;
      const definition = this.catalog.get(name);
      if (definition === undefined) {
        throw new Error2(ErrorCodes.WORKFLOW_NOT_FOUND, `Workflow "${name}" not found`, {
          details: { name },
        });
      }
      return definition;
    }
    try {
      const meta = extractWorkflowMeta(script!, {
        maxScriptBytes: this.limits().maxScriptBytes,
      });
      return { meta, script: script!, path: '', source: 'extra' };
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        throw new Error2(ErrorCodes.WORKFLOW_INVALID, error.message, { cause: error });
      }
      throw error;
    }
  }

  private limits(): WorkflowLimits {
    return resolveWorkflowLimits(this.config.get<WorkflowsConfig>(WORKFLOWS_SECTION));
  }

  private publish(caller: IAgentScopeHandle, event: WorkflowRunBusEvent): void {
    // The event bus is Agent-scoped: publish on the caller agent's bus through
    // a scope-handle borrow, same as the swarm's subagent.* facts.
    caller.accessor.get(IEventBus)?.publish(event);
  }

  private async runToCompletion(
    record: WorkflowRunRecord,
    definition: WorkflowDefinition,
    host: SubagentWorkflowHost,
    caller: IAgentScopeHandle,
    args: string,
    limits: WorkflowLimits,
    sink: AgentTaskSink,
  ): Promise<void> {
    const { runId } = record;
    const sessionId = this.sessionContext.sessionId;
    const appendLog = (line: string): void => {
      record.logs.push(line);
      if (record.logs.length > MAX_RUN_LOGS) record.logs.shift();
      sink.appendOutput(`${line}\n`);
    };

    const result = await runWorkflowScript(definition, {
      args,
      host,
      limits,
      signal: sink.signal,
      events: {
        onPhase: (title) => {
          record.phase = title;
          const metaIndex = record.phases.findIndex((phase) => phase.title === title);
          record.phaseIndex = metaIndex !== -1 ? metaIndex : (record.phaseIndex ?? -1) + 1;
          appendLog(`[phase] ${title}`);
          this.publish(caller, {
            type: 'workflow.run.phase',
            sessionId,
            runId,
            phase: title,
            phaseIndex: record.phaseIndex,
          });
        },
        onLog: (message) => {
          appendLog(`[log] ${message}`);
          this.publish(caller, { type: 'workflow.run.log', sessionId, runId, message });
        },
        onAgentCall: (info) => {
          record.agentCalls = Math.max(record.agentCalls, info.index);
          const label = info.label !== undefined ? ` ${info.label}` : '';
          appendLog(`[agent#${info.index}${label}] ${info.state}`);
          this.publish(caller, {
            type: 'workflow.run.agent_call',
            sessionId,
            runId,
            index: info.index,
            label: info.label,
            phase: info.phase,
            state: info.state,
          });
        },
      },
    });

    record.status = result.status;
    record.agentCalls = result.agentCalls;
    record.phase = result.phase ?? record.phase;
    record.endedAt = Date.now();
    if (result.status === 'failed') {
      record.error = result.error;
    } else if (result.status === 'completed') {
      record.resultJson = JSON.stringify(result.result);
      sink.appendOutput(`\n[result] ${record.resultJson}\n`);
    }

    this.publish(caller, {
      type: 'workflow.run.completed',
      sessionId,
      runId,
      status: result.status,
      agentCalls: result.agentCalls,
      error: result.status === 'failed' ? result.error : undefined,
      resultJson: record.resultJson,
    });

    // Settle semantics: a cancelled run was aborted through the sink signal
    // (task stop) — settle 'killed' so the task service records the stop
    // instead of a false success. Failures settle 'failed' with the script
    // error as the stop reason.
    if (result.status === 'completed') {
      await sink.settle({ status: 'completed' });
    } else if (result.status === 'failed') {
      await sink.settle({ status: 'failed', stopReason: result.error });
    } else {
      await sink.settle({ status: 'killed' });
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  IWorkflowRunService,
  WorkflowRunService,
  ScopeActivation.OnDemand,
  'workflow',
);

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function generateRunId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `wfrun-${suffix}`;
}
