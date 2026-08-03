/**
 * Workflow domain — types and interfaces.
 *
 * A workflow is a JavaScript script that orchestrates multi-phase agent work
 * using injected primitives: `agent()`, `parallel()`, `pipeline()`, `phase()`,
 * `log()`, and file IO. Scripts run in a Node.js `vm` sandbox with no access
 * to Node APIs — only the injected host functions.
 */

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: readonly string[];
}

export interface WorkflowEntry {
  readonly meta: WorkflowMeta;
  readonly script: string;
}

export interface AgentOpts {
  readonly agentType?: string;
  readonly model?: string;
  readonly schema?: Record<string, unknown>;
  readonly label?: string;
  readonly phase?: string;
  readonly timeoutMs?: number;
}

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: WorkflowStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly currentPhase?: string;
  readonly agentCount: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export interface WorkflowRunEntry {
  readonly runId: string;
  status: WorkflowStatus;
  result?: unknown;
  error?: string;
  currentPhase?: string;
  agentCount: number;
  readonly startedAt: number;
  finishedAt?: number;
  readonly abortController: AbortController;
}
