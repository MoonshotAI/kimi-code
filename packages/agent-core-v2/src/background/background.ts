import { createDecorator } from "#/_base/di";
import { BackgroundTaskPersistence } from './persist';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

export { AgentBackgroundTask } from './agent-task';
export type { AgentBackgroundTaskInfo } from './agent-task';
export { ProcessBackgroundTask } from './process-task';
export type { ProcessBackgroundTaskInfo } from './process-task';
export { QuestionBackgroundTask } from './question-task';
export type { QuestionBackgroundTaskInfo } from './question-task';
export { BackgroundTaskPersistence } from './persist';
export type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

export interface BackgroundServiceOptions {
  readonly persistence?: BackgroundTaskPersistence;
  readonly maxRunningTasks?: number;
}

export type BackgroundOptions = BackgroundServiceOptions;

export interface BackgroundLoadOptions {
  readonly replace?: boolean;
}

export interface BackgroundTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

export interface RegisterBackgroundTaskOptions {
  /**
   * When false, the task is tracked by the manager while a foreground tool call
   * still waits for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by the background manager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'terminal';

declare module '../types' {
  interface WireRecordMap {
    'background.task.started': {
      info: BackgroundTaskInfo;
    };
    'background.task.terminated': {
      info: BackgroundTaskInfo;
    };
  }
}

export interface IBackgroundService {
  readonly _serviceBrand: undefined;
  registerTask(task: BackgroundTask, options?: RegisterBackgroundTaskOptions): string;
  getTask(taskId: string): BackgroundTaskInfo | undefined;
  list(activeOnly?: boolean, limit?: number): readonly BackgroundTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  detach(taskId: string): BackgroundTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined>;
  stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]>;
  wait(taskId: string, timeoutMs?: number): Promise<BackgroundTaskInfo | undefined>;
  waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IBackgroundService =
  createDecorator<IBackgroundService>('agentBackgroundService');
