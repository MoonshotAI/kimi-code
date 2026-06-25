import type {
  BackgroundTaskOutputSnapshot,
  ForegroundTaskReleaseReason,
  RegisterBackgroundTaskOptions,
} from '../../agent/background';
import type { BackgroundTask, BackgroundTaskInfo } from '../../agent/background/task';

export interface BackgroundTaskRegistrar {
  registerTask(task: BackgroundTask, options?: RegisterBackgroundTaskOptions): string;
}

export interface BackgroundTaskLauncher extends BackgroundTaskRegistrar {
  getTask(taskId: string): BackgroundTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined>;
}

export interface BackgroundTaskManager extends BackgroundTaskLauncher {
  list(activeOnly?: boolean, limit?: number): readonly BackgroundTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(taskId: string, maxPreviewBytes: number): Promise<BackgroundTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  wait(taskId: string, timeoutMs?: number): Promise<BackgroundTaskInfo | undefined>;
  waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined>;
}
