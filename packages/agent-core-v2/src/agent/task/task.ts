/**
 * `task` domain (L5) — Agent-scope task manager contract.
 *
 * Defines the Agent-scoped task manager surface used for both foreground and
 * detached work. Task execution adapters implement the generic `AgentTask`
 * contract from this domain's type module; this service owns registration,
 * output retention, persistence, detach/stop/wait, terminal notifications,
 * and session-close task teardown with a `keepAliveOnExit` opt-out.
 * Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ITaskHandle } from '#/app/task/task';
import type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskStatus,
} from './types';

export { AgentTaskPersistence } from './persist';
export type {
  AgentTask,
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskKind,
  AgentTaskStatus,
} from './types';

export interface AgentTaskLoadOptions {
  readonly replace?: boolean;
}

export interface AgentTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

export interface RegisterAgentTaskOptions {
  /**
   * When false, the task is tracked by the manager while a foreground tool call
   * still waits for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by the task manager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /** Deadline to apply if a foreground task is detached. `0` and `undefined` do not arm a timer. */
  readonly detachTimeoutMs?: number;
  /**
   * When true, a foreground task whose deadline fires is detached to the
   * background (re-armed to `detachTimeoutMs`) instead of being killed.
   * Only meaningful for non-detached registrations.
   */
  readonly autoBackgroundOnTimeout?: boolean;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

/**
 * Options for tracking a TaskHandle with the Agent task service.
 * Callers create the handle via `taskService.run()`, then pass it here.
 */
export interface AgentTaskTrackOptions {
  readonly idPrefix?: string;
  readonly description: string;
  /** If `true`, the task is immediately detached (background). Default: `true`. */
  readonly detached?: boolean;
  /** Deadline after which the handle is cancelled. */
  readonly timeoutMs?: number;
  /** Deadline to apply if a foreground task is detached. */
  readonly detachTimeoutMs?: number;
  /** Foreground caller signal (ignored for detached tasks). */
  readonly signal?: AbortSignal;
  /** Callback to force-stop the underlying work (e.g., SIGKILL). */
  readonly forceStop?: () => Promise<void>;
  /** Hook called when a foreground task is detached. */
  readonly onDetach?: () => void;
  /** Produce the typed `AgentTaskInfo` from the base fields. */
  readonly toInfo: (base: AgentTaskInfoBase) => AgentTaskInfo;
}

/** Returned by `track()` so callers can race `handle.result` against detach. */
export interface IAgentTaskEntry {
  readonly taskId: string;
  /** Resolves with `'detached'` when the RPC layer detaches this task. */
  readonly onDidDetach: Promise<ForegroundTaskReleaseReason>;
}

export interface AgentTaskNotificationContext {
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface IAgentTaskService {
  readonly _serviceBrand: undefined;

  /** Track a `ITaskHandle` (from `taskService.run()`). */
  track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry;
  /** @deprecated Use `taskService.run()` + `track()` instead. */
  registerTask(task: AgentTask, options?: RegisterAgentTaskOptions): string;
  getTask(taskId: string): AgentTaskInfo | undefined;
  list(activeOnly?: boolean, limit?: number): readonly AgentTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  detach(taskId: string): AgentTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopAll(reason?: string): Promise<readonly AgentTaskInfo[]>;
  stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]>;
  wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined>;
  waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined>;
}

export const IAgentTaskService =
  createDecorator<IAgentTaskService>('agentTaskService');
