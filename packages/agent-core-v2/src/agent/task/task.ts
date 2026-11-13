import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type {
  AgentTaskInfo,
  AgentTaskInfoBase,
  AgentTaskStatus,
} from './types';

export { AgentTaskPersistence } from './persist';
export type {
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

export interface AgentTaskNotificationContext {
  readonly agentId: string;
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface IAgentTaskService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeTask: Event<AgentTaskInfo>;
  getTask(taskId: string): AgentTaskInfo | undefined;
  list(activeOnly?: boolean, limit?: number): readonly AgentTaskInfo[];
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<AgentTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  readOutputTail(taskId: string, maxBytes: number): Promise<AgentTaskOutputTail>;
  detach(taskId: string, text?: string): AgentTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined>;
  wait(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentTaskInfo | undefined>;
}

export const IAgentTaskService =
  createDecorator<IAgentTaskService>('agentTaskService');
