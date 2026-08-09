import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
} from '#/legacy/rpc-types';

// Event union plus shared fields/payloads used across event families.
// Event types are forwarded from the shared protocol package (the same source
// the retired agent-core re-exported); approval/question/tool-call reverse-RPC
// shapes are camelCase engine wire types kept locally in #/legacy/rpc-types.
export type { KimiErrorPayload, Event } from '@moonshot-ai/protocol';

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/protocol';

// Rust engine events (protocol-toward-engine): snake_case `host/event`
// stream, passed through by the SDK verbatim.
export type {
  EngineTurnStartedEvent,
  EngineTurnEndedEvent,
  EngineLlmStepBeginEvent,
  EngineLlmDeltaEvent,
  EngineLlmStepEndEvent,
  EngineToolStartedEvent,
  EngineToolSettledEvent,
  EngineGoalUpdatedEvent,
  EngineTaskStartedEvent,
  EngineTaskTerminatedEvent,
  EngineUsageUpdatedEvent,
  EngineHookResultEvent,
  EngineCompactionStartedEvent,
  EngineShellOutputEvent,
  // Host-synthesized events.
  HostSessionMetaUpdatedEvent,
  HostConfigUpdateEvent,
  HostPermissionSetModeEvent,
  HostTurnSteerEvent,
  HostSessionClosedEvent,
} from '@moonshot-ai/protocol';

// Session lifecycle/status events and their status payload.
export type {
  AgentStatusUpdatedEvent,
  ErrorEvent,
  WarningEvent,
} from '@moonshot-ai/protocol';

// Tool-call payload types (reverse-RPC and MCP OAuth update shapes).
export type {
  ToolUpdate,
  McpOAuthAuthorizationUrlUpdateData,
} from '@moonshot-ai/protocol';

export type { ToolCallRequest, ToolCallResponse } from '#/legacy/rpc-types';

// MCP server status payload types.
export type {
  McpServerStatusEvent,
  McpServerStatusPayload,
} from '@moonshot-ai/protocol';

// Approval reverse-RPC request and response/display payloads.
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalScope,
  ApprovalResponse,
} from '#/legacy/rpc-types';

export type { ToolInputDisplay } from '@moonshot-ai/protocol';

// Question reverse-RPC request and answer payloads.
export type {
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
} from '#/legacy/rpc-types';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;

/** Host-side tool execution handler: answers one engine `host/execute_tool`
 *  request for a session (host-provided tools, or calls no native tool
 *  claims). Registered per session via `Session.setToolHandler`. */
export type ToolCallHandler = (request: ToolCallRequest) => MaybePromise<ToolCallResponse>;
