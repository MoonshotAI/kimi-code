/**
 * Session-level workflow run manager: starts workflow runs as background
 * tasks, tracks per-run records, emits `workflow.run.*` events, and supports
 * cancellation through the background-task manager.
 */
import { randomBytes } from 'node:crypto';

import type { BackgroundManager } from '../agent/background';
import type { BackgroundTaskSink } from '../agent/background/task';
import { WorkflowBackgroundTask } from '../agent/background/workflow-task';
import type { AgentEvent } from '../rpc/events';
import { runWorkflowScript } from './runtime';
import type {
  WorkflowDefinition,
  WorkflowHost,
  WorkflowLimits,
  WorkflowPhaseMeta,
  WorkflowSource,
} from './types';

const MAX_RUN_LOGS = 200;

export interface WorkflowRunRecord {
  runId: string;
  workflowName: string;
  description: string;
  phases: WorkflowPhaseMeta[];
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phase?: string;
  phaseIndex?: number;
  agentCalls: number;
  /** Bounded log buffer: the most recent `MAX_RUN_LOGS` entries. */
  logs: string[];
  error?: string;
  resultJson?: string;
  startedAt: number;
  endedAt?: number;
  taskId?: string;
  scriptPath?: string;
  source: WorkflowSource;
  script: string;
  args: string;
}

export interface WorkflowRunManagerDeps {
  backgroundManager: () => BackgroundManager;
  emitEvent: (event: AgentEvent) => void;
  /** Host factory per run; receives the generated runId. */
  createHost: (runId: string) => WorkflowHost;
}

export interface StartWorkflowRunOptions {
  args: string;
  limits: WorkflowLimits;
}

export class WorkflowRunManager {
  private readonly runs = new Map<string, WorkflowRunRecord>();

  constructor(private readonly deps: WorkflowRunManagerDeps) {}

  start(
    definition: WorkflowDefinition,
    opts: StartWorkflowRunOptions,
  ): { runId: string; taskId: string } {
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
      args: opts.args,
    };
    this.runs.set(runId, record);

    const host = this.deps.createHost(runId);
    const task = new WorkflowBackgroundTask(
      `Workflow: ${definition.meta.name}`,
      (sink) => this.runToCompletion(record, definition, host, opts, sink),
      () => ({
        workflowName: record.workflowName,
        phase: record.phase,
        phases: record.phases,
        phaseIndex: record.phaseIndex,
        agentCalls: record.agentCalls,
      }),
    );
    const taskId = this.deps.backgroundManager().registerTask(task, {
      detached: true,
      timeoutMs: 0,
    });
    record.taskId = taskId;

    this.deps.emitEvent({
      type: 'workflow.run.started',
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
    void this.deps
      .backgroundManager()
      .stop(record.taskId, 'Workflow run cancelled')
      .catch(() => {});
    return true;
  }

  private async runToCompletion(
    record: WorkflowRunRecord,
    definition: WorkflowDefinition,
    host: WorkflowHost,
    opts: StartWorkflowRunOptions,
    sink: BackgroundTaskSink,
  ): Promise<void> {
    const { runId } = record;
    const emit = this.deps.emitEvent;
    const appendLog = (line: string): void => {
      record.logs.push(line);
      if (record.logs.length > MAX_RUN_LOGS) record.logs.shift();
      sink.appendOutput(`${line}\n`);
    };

    const result = await runWorkflowScript(definition, {
      args: opts.args,
      host,
      limits: opts.limits,
      signal: sink.signal,
      events: {
        onPhase: (title) => {
          record.phase = title;
          const metaIndex = record.phases.findIndex((phase) => phase.title === title);
          record.phaseIndex =
            metaIndex !== -1 ? metaIndex : (record.phaseIndex ?? -1) + 1;
          appendLog(`[phase] ${title}`);
          emit({
            type: 'workflow.run.phase',
            runId,
            phase: title,
            phaseIndex: record.phaseIndex,
          });
        },
        onLog: (message) => {
          appendLog(`[log] ${message}`);
          emit({ type: 'workflow.run.log', runId, message });
        },
        onAgentCall: (info) => {
          record.agentCalls = Math.max(record.agentCalls, info.index);
          const label = info.label !== undefined ? ` ${info.label}` : '';
          appendLog(`[agent#${info.index}${label}] ${info.state}`);
          emit({
            type: 'workflow.run.agent_call',
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

    emit({
      type: 'workflow.run.completed',
      runId,
      status: result.status,
      agentCalls: result.agentCalls,
      error: result.status === 'failed' ? result.error : undefined,
      resultJson: record.resultJson,
    });

    // Settle semantics: a cancelled run was aborted through the sink signal
    // (BackgroundManager.stop) — settle 'killed' so the manager records the
    // stop instead of a false success. Failures settle 'failed' with the
    // script error as the stop reason.
    if (result.status === 'completed') {
      await sink.settle({ status: 'completed' });
    } else if (result.status === 'failed') {
      await sink.settle({ status: 'failed', stopReason: result.error });
    } else {
      await sink.settle({ status: 'killed' });
    }
  }
}

const _ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function generateRunId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += _ALPHABET[bytes[i]! % 36];
  }
  return `wfrun-${suffix}`;
}
