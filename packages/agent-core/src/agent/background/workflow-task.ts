import type {
  BackgroundTask,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from './task';

export interface WorkflowPhaseInfo {
  readonly title: string;
  readonly detail?: string;
}

export interface WorkflowBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'workflow';
  readonly workflowName: string;
  readonly phase?: string;
  readonly phases?: readonly WorkflowPhaseInfo[];
  readonly phaseIndex?: number;
  readonly agentCalls?: number;
}

export interface WorkflowTaskSnapshot {
  readonly workflowName: string;
  readonly phase?: string;
  readonly phases?: readonly WorkflowPhaseInfo[];
  readonly phaseIndex?: number;
  readonly agentCalls?: number;
}

/**
 * Background task wrapping one workflow run. The `WorkflowRunManager` owns the
 * actual execution (`runWorkflowScript` + event emission); this class only
 * bridges it into the `BackgroundManager` lifecycle and reflects the current
 * run state through `toInfo`.
 */
export class WorkflowBackgroundTask implements BackgroundTask {
  readonly kind = 'workflow' as const;
  readonly idPrefix: string = 'workflow';

  constructor(
    readonly description: string,
    private readonly run: (sink: BackgroundTaskSink) => Promise<void>,
    private readonly snapshot: () => WorkflowTaskSnapshot,
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    await this.run(sink);
  }

  toInfo(base: BackgroundTaskInfoBase): WorkflowBackgroundTaskInfo {
    return {
      ...base,
      kind: 'workflow',
      ...this.snapshot(),
    };
  }
}
