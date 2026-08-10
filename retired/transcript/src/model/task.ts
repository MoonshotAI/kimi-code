/**
 * Execution entities that frames reference by id (`taskId`).
 *
 * Tasks live (and are rendered) globally per agent transcript — they never
 * participate in turn pagination. Streaming output rides on the shared
 * `append` op with `target: 'task'`.
 */

import type { AgentId, TaskId } from './ids';
import type { StepUsage } from './turn';

export type TaskKind = 'shell' | 'subagent' | 'tool' | 'other';

export type TaskState =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface TranscriptTask {
  readonly taskId: TaskId;
  readonly kind: TaskKind;
  readonly state: TaskState;
  /** Foreground→background transition: `!shell` detach, task tool backgrounding. */
  readonly detached: boolean;
  /** Human-readable one-liner (command line, agent description, …). */
  readonly description?: string;
  /** For kind 'subagent' / swarm members: the spawned agent's transcript to subscribe. */
  readonly agentId?: AgentId;
  /** Tail of captured output; appended via `append { target: 'task' }`. */
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** One-line result summary (`subagent.completed`). */
  readonly resultSummary?: string;
  /** Failure message (`subagent.failed`). */
  readonly error?: string;
  /** Why the task entered its current state (`subagent.suspended` reason). */
  readonly stateReason?: string;
  /** Token usage of the finished run (`subagent.completed`). */
  readonly usage?: StepUsage;
}
