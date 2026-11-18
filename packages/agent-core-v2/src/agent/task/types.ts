export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export const TERMINAL_STATUSES: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
export interface AgentTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly resumeReminded?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
  readonly stopCode?: string;
  readonly parentToolCallId?: string;
}

export interface SubagentTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly parentToolCallId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly stopCode?: string;
  readonly swarmIndex?: number;
  readonly stateReason?: string;
  readonly resultSummary?: string;
}

export interface QuestionTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export interface AgentTaskInfoByKind {
  readonly process: ProcessTaskInfo;
  readonly agent: SubagentTaskInfo;
  readonly question: QuestionTaskInfo;
}

export type AgentTaskKind = Extract<keyof AgentTaskInfoByKind, string>;

export type AgentTaskInfo = AgentTaskInfoByKind[AgentTaskKind];

export interface TaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export type TaskInfo = TaskInfoBase &
  (
    | {
        readonly kind: 'process';
        readonly command: string;
        readonly pid: number;
        readonly exitCode: number | null;
      }
    | {
        readonly kind: 'agent';
        readonly agentId?: string;
        readonly subagentType?: string;
        readonly model?: string;
        readonly thinkingEffort?: string;
      }
    | {
        readonly kind: 'question';
        readonly questionCount: number;
        readonly toolCallId?: string;
      }
  );

export interface TaskStartedEvent {
  readonly type: 'task.started';
  readonly info: TaskInfo;
}

export interface TaskTerminatedEvent {
  readonly type: 'task.terminated';
  readonly info: TaskInfo;
}

export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: TaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: TaskInfo;
}
