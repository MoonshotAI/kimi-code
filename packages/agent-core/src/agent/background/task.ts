import type { AgentBackgroundTaskInfo } from './agent-task';
import type { ProcessBackgroundTaskInfo } from './process-task';
import type { QuestionBackgroundTaskInfo } from './question-task';

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
  /**
   * `false` means a tool call is still waiting on this task in the
   * foreground. Omitted legacy records should be treated as detached.
   */
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Human-readable reason for the terminal status, when available. */
  readonly stopReason?: string;
  /** Suppress automatic terminal notifications/reminders for this task. */
  readonly terminalNotificationSuppressed?: boolean;
  /** Deadline supplied at registration; surfaced via task info. */
  readonly timeoutMs?: number;
}

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

export interface BackgroundTaskSink {
  readonly signal: AbortSignal;
  appendOutput(chunk: string): void;
  settle(settlement: BackgroundTaskSettlement): Promise<boolean>;
}

export interface BackgroundTask {
  readonly idPrefix: string;
  readonly kind: BackgroundTaskInfo['kind'];
  readonly description: string;
  readonly timeoutMs?: number;

  start(sink: BackgroundTaskSink): void | Promise<void>;
  onDetach?(): void;
  forceStop?(): Promise<void>;
  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo;
}
