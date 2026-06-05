/**
 * `@moonshot-ai/services` — in-process service container for the kimi-code
 * daemon. Houses broker interfaces (reverse-RPC: KimiCore → daemon) and the
 * `HarnessBridge` that owns the in-process `KimiCore` instance.
 *
 * Positive `IXxxService` interfaces (e.g. `ISessionService`) land per Chain
 * in Phase 1; W3 ships only the broker (reverse) side + the bridge shell.
 */

export * from './interfaces';
export { BridgeClientAPI } from './bridge/bridge-client-api';
export type { BridgeClientAPIDeps } from './bridge/bridge-client-api';
export {
  HarnessBridge,
  IHarnessBridge,
  type HarnessBridgeOptions,
  type HarnessRPC,
} from './bridge/harness-bridge';
export {
  defaultServicesModule,
  type ServiceModuleEntry,
} from './module';
export {
  SessionServiceImpl,
  toProtocolSession,
} from './impls/session-service-impl';
export {
  MessageServiceImpl,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './impls/message-service-impl';
export { PromptServiceImpl } from './impls/prompt-service-impl';
export type {
  SyntheticPromptAbortedEvent,
  SyntheticPromptCompletedEvent,
} from './impls/prompt-service-impl';
export {
  AuthSummaryServiceImpl,
  type AuthSummaryServiceOptions,
} from './impls/auth-summary-service-impl';
export {
  OAuthServiceImpl,
  type OAuthServiceOptions,
} from './impls/oauth-service-impl';
export { ToolServiceImpl } from './impls/tool-service-impl';
export { McpServiceImpl } from './impls/mcp-service-impl';
export { TaskServiceImpl } from './impls/task-service-impl';

// Adapter helpers (protocol wire shape ↔ in-process SDK shape). One file per
// reverse-RPC interaction (W8.1: approval, W8.2: question). Daemon REST
// handlers + brokers consume these.
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './adapter/approval-adapter';
export {
  toAgentCoreResponse as questionToAgentCoreResponse,
  toBrokerRequest as questionToBrokerRequest,
  dismissedResult as questionDismissedResult,
  type QuestionToBrokerRequestParams,
} from './adapter/question-adapter';
// W9.1 / Chain 7 — Tool + MCP adapter.
export {
  toProtocolTool,
  toProtocolMcpServer,
  type AgentCoreToolInfoLike,
} from './adapter/tool-adapter';
// W9.2 / Chain 8 — Background Task adapter.
export { toProtocolTask, isTerminalStatus } from './adapter/task-adapter';
// NOTE: `registerHarnessBridge` (./bridge/lifecycle.ts) is intentionally not
// re-exported. `defaultServicesModule()` is the canonical wiring path; the
// registry-style helper exists only for legacy side-effect-on-import contexts.
