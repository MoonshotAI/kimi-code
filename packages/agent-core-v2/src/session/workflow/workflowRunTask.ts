/**
 * `workflow` domain (L6) — `AgentTask` adapter for a workflow run.
 *
 * Wraps a workflow run's drive-to-completion callback as a background task on
 * the caller agent's task service, so the run is visible under
 * TaskList/TaskOutput/TaskStop and its completion arrives as an automatic
 * notification. The run service owns the record and event emission; this
 * adapter only bridges the task-service sink (signal, output, settlement) and
 * exposes the workflow-shaped `toInfo` snapshot.
 */

import {
  type AgentTask,
  type AgentTaskInfoBase,
  type AgentTaskSink,
} from '#/agent/task/types';
import type { WorkflowPhaseMeta } from '#/app/workflow/runtime/types';

export interface WorkflowRunTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'workflow';
  readonly runId: string;
  readonly workflowName: string;
  readonly phase?: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly phaseIndex?: number;
  readonly agentCalls?: number;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly workflow: WorkflowRunTaskInfo;
  }
}

export interface WorkflowRunTaskSnapshot {
  readonly runId: string;
  readonly workflowName: string;
  readonly phase?: string;
  readonly phases: readonly WorkflowPhaseMeta[];
  readonly phaseIndex?: number;
  readonly agentCalls: number;
}

export class WorkflowRunTask implements AgentTask {
  readonly kind = 'workflow' as const;
  readonly idPrefix: string = 'workflow';

  constructor(
    readonly description: string,
    private readonly execute: (sink: AgentTaskSink) => Promise<void>,
    private readonly snapshot: () => WorkflowRunTaskSnapshot,
  ) {}

  start(sink: AgentTaskSink): Promise<void> {
    return this.execute(sink);
  }

  toInfo(base: AgentTaskInfoBase): WorkflowRunTaskInfo {
    const snapshot = this.snapshot();
    return {
      ...base,
      kind: 'workflow',
      runId: snapshot.runId,
      workflowName: snapshot.workflowName,
      phase: snapshot.phase,
      phases: snapshot.phases,
      phaseIndex: snapshot.phaseIndex,
      agentCalls: snapshot.agentCalls,
    };
  }
}
