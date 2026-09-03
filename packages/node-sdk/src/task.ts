import type { AgentTaskStatus } from '@moonshot-ai/agent-core-v2/agent/task/types';
import type { QuestionTaskInfo } from '@moonshot-ai/agent-core-v2/agent/tools/ask-user-question/question-background-task';
import type { SubagentTaskInfo } from '@moonshot-ai/agent-core-v2/agent/tools/agent/subagent-task';
import type { ProcessTaskInfo } from '@moonshot-ai/agent-core-v2/agent/tools/os/bash/process-task';

export type BackgroundTaskStatus = AgentTaskStatus;

export type ProcessBackgroundTaskInfo = ProcessTaskInfo;

export type AgentBackgroundTaskInfo = SubagentTaskInfo;

export type QuestionBackgroundTaskInfo = QuestionTaskInfo;

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;
