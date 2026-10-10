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

export interface TranscriptTaskUpdate {
  readonly title: string;
  readonly message: string;
  readonly at?: string;
}

export const TRANSCRIPT_TASK_UPDATES_LIMIT = 20;

export interface TranscriptTask {
  readonly taskId: TaskId;
  readonly kind: TaskKind;
  readonly state: TaskState;
  readonly detached: boolean;
  readonly description?: string;
  readonly agentId?: AgentId;
  readonly outputTail: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly stateReason?: string;
  readonly usage?: StepUsage;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly updates?: readonly TranscriptTaskUpdate[];
}

export function appendTaskUpdate(
  updates: readonly TranscriptTaskUpdate[] | undefined,
  update: TranscriptTaskUpdate,
): readonly TranscriptTaskUpdate[] {
  return [...(updates ?? []), update].slice(-TRANSCRIPT_TASK_UPDATES_LIMIT);
}
