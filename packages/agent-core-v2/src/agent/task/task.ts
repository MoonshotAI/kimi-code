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
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly autoBackgroundOnTimeout?: boolean;
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

export interface AgentTaskTrackOptions {
  readonly idPrefix?: string;
  readonly description: string;
  readonly detached?: boolean;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly forceStop?: () => Promise<void>;
  readonly onDetach?: () => void;
  readonly toInfo: (base: AgentTaskInfoBase) => AgentTaskInfo;
}

export interface IAgentTaskEntry {
  readonly taskId: string;
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

  track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry;
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
