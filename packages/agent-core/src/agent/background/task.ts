export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export const TERMINAL_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set<BackgroundTaskStatus>([
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);
export type BackgroundTaskSettlementStatus = 'completed' | 'failed' | 'timed_out' | 'killed';

export interface BackgroundTaskSettlement {
  readonly status: BackgroundTaskSettlementStatus;
  /** Human-readable reason for the terminal status, when available. */
  readonly stopReason?: string;
}

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Human-readable reason for the terminal status, when available. */
  readonly stopReason?: string;
  /** Deadline supplied at registration; surfaced via task info. */
  readonly timeoutMs?: number;
}

export type BackgroundTaskInfo =
  | (BackgroundTaskInfoBase & {
      readonly kind: 'process';
      readonly command: string;
      readonly pid: number;
      readonly exitCode: number | null;
    })
  | (BackgroundTaskInfoBase & {
      readonly kind: 'agent';
      /** Subagent identifier accepted by Agent(resume=...). */
      readonly agentId?: string;
      /** Subagent profile name. */
      readonly subagentType?: string;
    });

export interface BackgroundTaskSink {
  readonly signal: AbortSignal;
  appendOutput(chunk: string): void;
  settle(settlement: BackgroundTaskSettlement): Promise<boolean>;
}

export interface BackgroundTask {
  readonly idPrefix: string;
  readonly kind: string;
  readonly description: string;
  readonly timeoutMs?: number;

  start(sink: BackgroundTaskSink): void | Promise<void>;
  forceStop?(): Promise<void>;
  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo;
}
