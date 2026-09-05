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
}
