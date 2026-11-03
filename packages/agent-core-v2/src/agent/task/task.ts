import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
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

export interface AgentTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

export interface AgentTaskOutputChunk {
  readonly taskId: string;
  readonly offset: number;
  readonly text: string;
}

export interface AgentTaskOutputTail {
  readonly offset: number;
  readonly data: Uint8Array;
}

export interface RegisterAgentTaskOptions {
  readonly detached?: boolean;
  readonly detachable?: boolean;
  readonly timeoutMs?: number;
  readonly detachTimeoutMs?: number;
  readonly autoBackgroundOnTimeout?: boolean;
  readonly signal?: AbortSignal;
  readonly coreDetachedTool?: boolean;
  readonly detachText?: (viaTimeout: boolean) => string;
  readonly onDetach?: (viaTimeout: boolean) => void;
}

export interface AgentTaskNotificationContext {
  readonly agentId: string;
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface AgentTaskWaitDelivery {
  readonly taskId: string;
  readonly status: AgentTaskStatus;
}

export interface IAgentTaskService {
  readonly _serviceBrand: undefined;

  readonly onDidAppendOutput: Event<AgentTaskOutputChunk>;
  readonly onDidChangeTask: Event<AgentTaskInfo>;

  registerTask(task: AgentTask, options?: RegisterAgentTaskOptions): string;
  getTask(taskId: string): AgentTaskInfo | undefined;
  refresh(taskId: string): void;
  list(activeOnly?: boolean, limit?: number): readonly AgentTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  readOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  suppressAllTerminalNotifications(): Promise<void>;
  markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void;
  detach(taskId: string, text?: string): AgentTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined>;
  stopAll(reason?: string): Promise<readonly AgentTaskInfo[]>;
  stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo[]>;
  wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined>;
}

export const IAgentTaskService =
  createDecorator<IAgentTaskService>('agentTaskService');
