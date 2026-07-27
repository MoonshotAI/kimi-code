/**
 * `workflow` domain (L6) — `IWorkflowRunService` contract (Session scope).
 *
 * Owns the session's Dynamic Workflow runs: starts a run as a detached
 * background task on the caller agent's task service (visible under
 * TaskList/TaskOutput/TaskStop, with an automatic completion notification),
 * tracks the per-run record, emits the `workflow.run.*` facts on the event
 * bus, and propagates cancellation. One instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type {
  WorkflowPhaseMeta,
  WorkflowSource,
} from '#/app/workflow/runtime/types';

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunRecord {
  runId: string;
  workflowName: string;
  description: string;
  phases: WorkflowPhaseMeta[];
  status: WorkflowRunStatus;
  phase?: string;
  phaseIndex?: number;
  agentCalls: number;
  /** Bounded log buffer: the most recent entries. */
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
  callerAgentId: string;
}

export interface StartWorkflowRunInput {
  /** Name of a catalog workflow; mutually exclusive with `script`. */
  readonly name?: string;
  /** Inline workflow script; mutually exclusive with `name`. */
  readonly script?: string;
  readonly args: string;
  /** Agent the run's subagents are mirrored onto and whose task service tracks the run. */
  readonly callerAgentId: string;
}

export interface WorkflowRunStartedEvent {
  readonly type: 'workflow.run.started';
  readonly sessionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workflowName: string;
  readonly description: string;
  readonly phases: readonly WorkflowPhaseMeta[];
}

export interface WorkflowRunPhaseEvent {
  readonly type: 'workflow.run.phase';
  readonly sessionId: string;
  readonly runId: string;
  readonly phase: string;
  readonly phaseIndex?: number;
}

export interface WorkflowRunLogEvent {
  readonly type: 'workflow.run.log';
  readonly sessionId: string;
  readonly runId: string;
  readonly message: string;
}

export interface WorkflowRunAgentCallEvent {
  readonly type: 'workflow.run.agent_call';
  readonly sessionId: string;
  readonly runId: string;
  readonly index: number;
  readonly label?: string;
  readonly phase?: string;
  readonly state: 'started' | 'ok' | 'refused' | 'error';
}

export interface WorkflowRunCompletedEvent {
  readonly type: 'workflow.run.completed';
  readonly sessionId: string;
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly agentCalls: number;
  readonly error?: string;
  readonly resultJson?: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'workflow.run.started': WorkflowRunStartedEvent;
    'workflow.run.phase': WorkflowRunPhaseEvent;
    'workflow.run.log': WorkflowRunLogEvent;
    'workflow.run.agent_call': WorkflowRunAgentCallEvent;
    'workflow.run.completed': WorkflowRunCompletedEvent;
  }
}

export interface IWorkflowRunService {
  readonly _serviceBrand: undefined;

  /**
   * Resolve the definition (catalog `name` or inline `script`), start the run
   * in the background, and return immediately with its ids. Throws
   * `workflow.not_found` / `workflow.invalid`.
   */
  start(input: StartWorkflowRunInput): Promise<{ readonly runId: string; readonly taskId: string }>;
  list(): WorkflowRunRecord[];
  get(runId: string): WorkflowRunRecord | undefined;
  /** Request cancellation of a running run; false when unknown or already terminal. */
  cancel(runId: string): boolean;
}

export const IWorkflowRunService: ServiceIdentifier<IWorkflowRunService> =
  createDecorator<IWorkflowRunService>('workflowRunService');
