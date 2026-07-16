/**
 * Workflow service — App-scope service that manages workflow runs.
 *
 * Holds run entries in a Map, forks execution fibers, and provides
 * status/wait/cancel operations. The service is App-scoped so runs
 * survive across agent turns.
 */

import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { createDecorator } from '#/_base/di/instantiation';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';

import type { WorkflowMeta, WorkflowRunEntry, WorkflowRunResult } from './workflowTypes';
import { executeWorkflow, type WorkflowRuntimeDeps } from './workflowRuntime';

export interface WorkflowStartInput {
  readonly script: string;
  readonly args?: unknown;
  readonly callerAgentId: string;
  readonly sessionContext: ISessionContext;
  readonly lifecycle: IAgentLifecycleService;
  readonly subagents: ISessionSubagentService;
}

export interface IWorkflowService {
  readonly _serviceBrand: undefined;
  start(input: WorkflowStartInput): Promise<{ runId: string }>;
  status(runId: string): WorkflowRunResult | undefined;
  wait(runId: string, timeoutMs?: number): Promise<WorkflowRunResult>;
  cancel(runId: string): Promise<void>;
  listBuiltins(): readonly WorkflowMeta[];
}

export const IWorkflowService = createDecorator<IWorkflowService>('workflowService');

export class WorkflowService extends Disposable implements IWorkflowService {
  declare readonly _serviceBrand: undefined;

  private readonly runs = new Map<string, WorkflowRunEntry>();
  private counter = 0;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(toDisposable(() => {
      for (const entry of this.runs.values()) {
        if (entry.status === 'running') {
          entry.abortController.abort();
        }
      }
    }));
  }

  async start(input: WorkflowStartInput): Promise<{ runId: string }> {
    const runId = `wf_${++this.counter}`;
    const entry: WorkflowRunEntry = {
      runId,
      status: 'running',
      agentCount: 0,
      startedAt: Date.now(),
      abortController: new AbortController(),
    };
    this.runs.set(runId, entry);

    // Fork execution — don't await.
    void this.runWorkflow(runId, input, entry).catch((err) => {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.finishedAt = Date.now();
      this.log.error('workflow.run.uncaught', { runId, error: entry.error });
    });

    return { runId };
  }

  private async runWorkflow(
    runId: string,
    input: WorkflowStartInput,
    entry: WorkflowRunEntry,
  ): Promise<void> {
    const deps: WorkflowRuntimeDeps = {
      lifecycle: input.lifecycle,
      subagents: input.subagents,
      sessionContext: input.sessionContext,
      log: this.log,
      callerAgentId: input.callerAgentId,
      workspaceRoot: input.sessionContext.cwd,
    };

    try {
      const result = await executeWorkflow({
        script: input.script,
        args: input.args,
        deps,
        entry,
      });
      entry.status = 'completed';
      entry.result = result;
      entry.finishedAt = Date.now();
      this.log.info('workflow.run.completed', { runId, agentCount: entry.agentCount });
    } catch (err) {
      if (entry.abortController.signal.aborted) {
        entry.status = 'cancelled';
      } else {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : String(err);
      }
      entry.finishedAt = Date.now();
      this.log.warn('workflow.run.failed', { runId, error: entry.error });
    }
  }

  status(runId: string): WorkflowRunResult | undefined {
    const entry = this.runs.get(runId);
    if (entry === undefined) return undefined;
    return toResult(entry);
  }

  async wait(runId: string, timeoutMs?: number): Promise<WorkflowRunResult> {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      return { runId, status: 'failed', error: 'Workflow run not found', agentCount: 0, startedAt: 0 };
    }

    if (entry.status !== 'running') {
      return toResult(entry);
    }

    // Poll until done or timeout.
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
    while (entry.status === 'running') {
      if (deadline !== undefined && Date.now() >= deadline) {
        return toResult(entry);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return toResult(entry);
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    if (entry.status === 'running') {
      entry.abortController.abort();
      // Give it a moment to settle.
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (entry.status === 'running') {
        entry.status = 'cancelled';
        entry.finishedAt = Date.now();
      }
    }
  }

  listBuiltins(): readonly WorkflowMeta[] {
    // Lazy import to avoid circular dependency at module load.
    return listBuiltinsLazy();
  }
}

function toResult(entry: WorkflowRunEntry): WorkflowRunResult {
  return {
    runId: entry.runId,
    status: entry.status,
    result: entry.result,
    error: entry.error,
    currentPhase: entry.currentPhase,
    agentCount: entry.agentCount,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
  };
}

// Lazy import to break circular dependency.
let listBuiltinsLazyFn: (() => readonly WorkflowMeta[]) | undefined;
function listBuiltinsLazy(): readonly WorkflowMeta[] {
  if (listBuiltinsLazyFn === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listBuiltins } = require('./workflowRegistry') as {
      listBuiltins: () => readonly WorkflowMeta[];
    };
    listBuiltinsLazyFn = listBuiltins;
  }
  return listBuiltinsLazyFn();
}

registerScopedService(
  LifecycleScope.App,
  IWorkflowService,
  WorkflowService,
  InstantiationType.Eager,
  'workflow',
);
