export interface Subtask {
  id: string;
  role: string;
  systemPrompt: string;
  prompt: string;
  toolAllowlist?: string[] | undefined;
  status: 'pending' | 'running' | 'done' | 'failed' | 'dropped';
  result?: string | undefined;
  error?: string | undefined;
  /** Number of times this subtask has actually been executed by a worker. */
  attempts: number;
}

export interface SwarmPlan {
  rootTask: string;
  subtasks: Subtask[];
}

/** What the coordinator needs to run one subagent to completion. */
export type SpawnSubagentFn = (args: {
  profileName: string;
  systemPrompt: string;
  tools: string[];
  prompt: string;
  description: string;
  signal: AbortSignal;
}) => Promise<{ result: string }>;

/**
 * Decision a reviser subagent makes about a single failed/stalled subtask.
 * Shape mirrors the JSON the reviser emits (see {@link parseReviseDecision}).
 */
export type ReviseDecision =
  | { kind: 'retry' }
  | { kind: 'regenerate'; prompt: string }
  | { kind: 'reassign'; role: string; systemPrompt: string; toolAllowlist?: string[] }
  | { kind: 'drop'; reason: string };

export type SwarmProgress =
  | { phase: 'planned'; total: number }
  | {
      phase: 'revising';
      subtaskId: string;
      /**
       * The subtask's role at the moment the reviser decision is emitted, i.e.
       * BEFORE the decision is applied. For a `reassign` this is the OLD role,
       * letting the dashboard correlate the event to the existing worker row.
       */
      role: string;
      decision: 'retry' | 'regenerate' | 'reassign' | 'drop';
      /**
       * For a `reassign`, the NEW role the subtask is being moved to (the
       * decision's role). Lets the dashboard re-key the existing OLD-role row to
       * the new role so the subtask keeps a single row across the reassign,
       * rather than stranding the old row in `retrying`. Absent for other
       * decisions.
       */
      newRole?: string;
      attempt: number;
    }
  | { phase: 'dropped'; subtaskId: string; role: string; reason: string }
  | { phase: 'synthesizing' }
  | { phase: 'done'; succeeded: number; failed: number; dropped: number };

export interface SwarmCoordinatorDeps {
  spawnSubagent: SpawnSubagentFn;
  signal: AbortSignal;
  onProgress?: ((text: string) => void) | undefined;
  onProgressCustom?: ((progress: SwarmProgress) => void) | undefined;
  maxConcurrency?: number | undefined;
  /**
   * Maximum number of times a single subtask is executed before it is
   * force-dropped (counting the original run). Defaults to
   * {@link DEFAULT_MAX_ATTEMPTS}.
   */
  maxAttempts?: number | undefined;
  /**
   * Safety bound on the number of wave iterations the recovery loop performs
   * before giving up, to guarantee termination. Defaults to
   * {@link DEFAULT_MAX_WAVES}.
   */
  maxWaves?: number | undefined;
}

/** Default repeat threshold for swarm worker stall detection. */
export const DEFAULT_STALL_REPEAT_THRESHOLD = 10;

/** Default cap on per-subtask execution attempts before a force-drop. */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** Default safety cap on recovery-loop wave iterations. */
export const DEFAULT_MAX_WAVES = 6;
