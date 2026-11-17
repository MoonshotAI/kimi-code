export type {
  SessionSummary,
  SessionDetail,
  AgentInfo,
  AgentNode,
  AgentTreeResponse,
  SessionHealth,
  WireResponse,
  WireEntry,
  ApiError,
  AgentRecord,
  AgentRecordOf,
  ContextMessage,
  PromptOrigin,
  TokenUsage,
  PermissionMode,
  LoopRecordedEvent,
  ContentPart,
  Message,
  ToolCall,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  AgentBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
  BackgroundTaskEntry,
  BackgroundTasksResponse,
  TaskOutputResponse,
  CronTask,
  CronTasksResponse,
  ImportInfo,
  ImportManifest,
  ImportResult,
  LogLine,
  LogsResponse,
  CoreContentPart,
} from '../../server/src/lib/agent-record-types';
export { mediaUrlOf } from '../../server/src/lib/agent-record-types';

export type {
  ProjectedMessage,
  UsageTotals,
  ConfigSnapshot,
  ContextProjection,
  GoalSnapshot,
} from '../../server/src/lib/context-projector';

export interface DeleteSessionResponse {
  sessionId: string;
  deleted: true;
}

export interface ContextResponse {
  sessionId: string;
  agentId: string;
  messages: import('../../server/src/lib/context-projector').ProjectedMessage[];
  usage: import('../../server/src/lib/context-projector').UsageTotals;
  contextTokens: number;
  config: import('../../server/src/lib/context-projector').ConfigSnapshot;
  permission: { mode: import('../../server/src/lib/agent-record-types').PermissionMode | null };
  planMode: { active: boolean; id?: string };
  goal: import('../../server/src/lib/context-projector').GoalSnapshot | null;
  swarm: { active: boolean; trigger?: string };
}
