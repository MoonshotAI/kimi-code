import type { Session } from '@moonshot-ai/kimi-code-sdk';

/**
 * A subset of `Session` covering all Dynamic Workflow operations.
 * Defined as a `Pick` so it stays in sync with the SDK interface and
 * can be implemented by a kap-server v2 client later.
 */
export type WorkflowV2Session = Pick<
  Session,
  | 'listWorkflows'
  | 'getWorkflow'
  | 'reloadWorkflows'
  | 'runWorkflow'
  | 'listWorkflowRuns'
  | 'getWorkflowRun'
  | 'cancelWorkflowRun'
  | 'saveWorkflow'
  | 'setWorkflowMode'
>;

/**
 * Abstraction for Dynamic Workflow operations.
 *
 * When a v2 session (kap-server / klient) is provided it is used
 * for every workflow call.  Otherwise the v1 `Session` is used as a
 * transparent fallback.  This lets the TUI migrate to the new engine
 * gradually without breaking existing functionality.
 *
 * ```ts
 * const client = new WorkflowV2Client(v1Session);
 * // later, when the v2 engine is available:
 * const client = new WorkflowV2Client(v1Session, v2Session);
 * ```
 */
export class WorkflowV2Client implements WorkflowV2Session {
  constructor(
    private readonly v1Session: Session,
    private readonly v2Session?: WorkflowV2Session,
  ) {}

  /** `true` when the kap-server v2 session is available. */
  get usingV2(): boolean {
    return this.v2Session !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Workflow discovery
  // ---------------------------------------------------------------------------

  async listWorkflows() {
    if (this.v2Session) return this.v2Session.listWorkflows();
    return this.v1Session.listWorkflows();
  }

  async getWorkflow(name: string) {
    if (this.v2Session) return this.v2Session.getWorkflow(name);
    return this.v1Session.getWorkflow(name);
  }

  async reloadWorkflows() {
    if (this.v2Session) return this.v2Session.reloadWorkflows();
    return this.v1Session.reloadWorkflows();
  }

  // ---------------------------------------------------------------------------
  // Running workflows
  // ---------------------------------------------------------------------------

  async runWorkflow(options: {
    name?: string;
    script?: string;
    args?: string;
  }) {
    if (this.v2Session) return this.v2Session.runWorkflow(options);
    return this.v1Session.runWorkflow(options);
  }

  async listWorkflowRuns() {
    if (this.v2Session) return this.v2Session.listWorkflowRuns();
    return this.v1Session.listWorkflowRuns();
  }

  async getWorkflowRun(runId: string) {
    if (this.v2Session) return this.v2Session.getWorkflowRun(runId);
    return this.v1Session.getWorkflowRun(runId);
  }

  async cancelWorkflowRun(runId: string) {
    if (this.v2Session) return this.v2Session.cancelWorkflowRun(runId);
    return this.v1Session.cancelWorkflowRun(runId);
  }

  async saveWorkflow(options: {
    script: string;
    scope: 'project' | 'user';
    overwrite?: boolean;
  }) {
    if (this.v2Session) return this.v2Session.saveWorkflow(options);
    return this.v1Session.saveWorkflow(options);
  }

  // ---------------------------------------------------------------------------
  // Workflow mode (on / off)
  // ---------------------------------------------------------------------------

  async setWorkflowMode(
    enabled: boolean,
    trigger?: 'manual' | 'command',
  ): Promise<void> {
    if (this.v2Session)
      return this.v2Session.setWorkflowMode(enabled, trigger ?? 'command');
    return this.v1Session.setWorkflowMode(enabled, trigger ?? 'command');
  }
}
