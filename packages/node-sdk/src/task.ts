import type {
  AgentTaskStatus,
  ProcessTaskInfo,
  QuestionTaskInfo,
  SubagentTaskInfo,
} from '@moonshot-ai/agent-core-v2/agent/task/types';

export type BackgroundTaskStatus = AgentTaskStatus;

export type ProcessBackgroundTaskInfo = ProcessTaskInfo;

export type AgentBackgroundTaskInfo = SubagentTaskInfo;

export type QuestionBackgroundTaskInfo = QuestionTaskInfo;

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;
