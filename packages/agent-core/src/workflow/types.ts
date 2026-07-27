/**
 * Dynamic Workflows — core types.
 *
 * A workflow is a user-approved JS script that orchestrates subagents in
 * phases (parallel fan-out, pipelines, structured JSON-schema output). The
 * script runs inside a restricted `node:vm` context; the subagent host is an
 * injected interface implemented by a future slice.
 */

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
}

export interface WorkflowMeta {
  /** Kebab-case identifier: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, max 64 chars. */
  name: string;
  /** Non-empty, max 500 chars. */
  description: string;
  whenToUse?: string;
  /** Optional hint for the argument the workflow expects, max 200 chars. */
  argumentHint?: string;
  /** 1..24 phases with non-empty, unique titles. */
  phases: WorkflowPhaseMeta[];
}

export type WorkflowSource = 'project' | 'user' | 'extra' | 'builtin';

export interface WorkflowDefinition {
  meta: WorkflowMeta;
  /** Full script text. */
  script: string;
  /** File path ('' or a synthetic path for inline/builtin workflows). */
  path: string;
  source: WorkflowSource;
}

export interface SkippedWorkflow {
  path: string;
  reason: string;
}

export interface WorkflowLimits {
  maxConcurrency: number;
  maxAgentCalls: number;
  maxDurationMs: number;
  maxScriptBytes: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxConcurrency: 4,
  maxAgentCalls: 50,
  maxDurationMs: 30 * 60_000,
  maxScriptBytes: 256 * 1024,
};

export interface WorkflowLimitsConfig {
  maxConcurrency?: number;
  maxAgentCalls?: number;
  maxDurationMs?: number;
  maxScriptBytes?: number;
}

export function resolveWorkflowLimits(config?: WorkflowLimitsConfig): WorkflowLimits {
  return {
    maxConcurrency: config?.maxConcurrency ?? DEFAULT_WORKFLOW_LIMITS.maxConcurrency,
    maxAgentCalls: config?.maxAgentCalls ?? DEFAULT_WORKFLOW_LIMITS.maxAgentCalls,
    maxDurationMs: config?.maxDurationMs ?? DEFAULT_WORKFLOW_LIMITS.maxDurationMs,
    maxScriptBytes: config?.maxScriptBytes ?? DEFAULT_WORKFLOW_LIMITS.maxScriptBytes,
  };
}

// ─── Injected subagent host (implemented in a future slice) ────────────────

export interface WorkflowAgentRequest {
  prompt: string;
  label?: string;
  phase?: string;
  /** JSON Schema the caller expects the agent output to satisfy, serialized. */
  schemaJson?: string;
}

export type WorkflowAgentOutcome =
  | { status: 'ok'; text: string }
  | { status: 'refused' }
  | { status: 'error'; message: string };

export interface WorkflowHost {
  runAgent(request: WorkflowAgentRequest, signal: AbortSignal): Promise<WorkflowAgentOutcome>;
}
