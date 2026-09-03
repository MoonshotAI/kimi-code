import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '#/interaction';

export type { KimiErrorPayload } from '#/errors';

export type { Event } from '@moonshot-ai/protocol';

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

export type {
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  GoalUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ErrorEvent,
  WarningEvent,
  UsageStatus,
} from '@moonshot-ai/protocol';

export type {
  TurnStartedEvent,
  TurnEndedEvent,
  TurnStepStartedEvent,
  TurnStepCompletedEvent,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
  TurnEndReason,
} from '@moonshot-ai/protocol';

export type {
  AssistantDeltaEvent,
  HookResultEvent,
  ThinkingDeltaEvent,
} from '@moonshot-ai/protocol';

export type {
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ToolUpdate,
  McpOAuthAuthorizationUrlUpdateData,
} from '@moonshot-ai/protocol';

export type { ToolCallRequest, ToolCallResponse } from '#/interaction';

export type {
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
  McpServerStatusEvent,
  McpServerStatusPayload,
} from '@moonshot-ai/protocol';

export type { ApprovalRequest, ApprovalScope } from '#/interaction';
export type { ApprovalDecision, ApprovalResponse } from '#/interaction';

export type { ToolInputDisplay } from '@moonshot-ai/protocol';

export type {
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
} from '#/interaction';

export type {
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
} from '@moonshot-ai/protocol';

export type {
  CompactionStartedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionResult,
} from '@moonshot-ai/protocol';

export type {
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
} from '@moonshot-ai/protocol';

export type { CronFiredEvent } from '@moonshot-ai/protocol';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
