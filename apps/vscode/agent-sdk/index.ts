/**
 * Kimi Code Agent SDK - TypeScript SDK for Kimi Code Agent Client Protocol (ACP).
 *
 * @example Quick Start
 * ```typescript
 * import { createSession } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
 *
 * const session = createSession({
 *   workDir: process.cwd(),
 *   model: "kimi-k2-0711-preview",
 * });
 *
 * const turn = session.prompt("Hello");
 * for await (const event of turn) {
 *   if (event.type === "ContentPart" && event.payload.type === "text") {
 *     console.log(event.payload.text);
 *   }
 *   if (event.type === "ApprovalRequest") {
 *     await turn.approve(event.payload.id, "approve");
 *   }
 * }
 *
 * await session.close();
 * ```
 *
 * @module @moonshot-ai/kimi-code-vscode-agent-sdk
 */

// Session
export { createSession, prompt } from "./session";
export type { Session, Turn, SessionState } from "./session";

// Storage
export { listSessions, deleteSession } from "./storage";

// History
export { parseSessionEvents } from "./history/context-extract";

// Config
export { parseConfig, saveDefaultModel, getModelById, isModelThinking, getModelThinkingMode } from "./config";
export type { ThinkingMode } from "./config";

// Paths
export { KimiPaths } from "./paths";

// Errors
export {
  AgentSdkError,
  TransportError,
  ProtocolError,
  SessionError,
  CliError,
  isAgentSdkError,
  getErrorCode,
  getErrorCategory,
  TransportErrorCodes,
  ProtocolErrorCodes,
  SessionErrorCodes,
  CliErrorCodes,
} from "./errors";
export type { ErrorCategory, TransportErrorCodeType, ProtocolErrorCodeType, SessionErrorCodeType, CliErrorCodeType } from "./errors";

// Utils
export { cleanSystemTags, cleanUserInput, extractBrief, extractTextFromContentParts, formatContentOutput } from "./utils";

// ACP legacy compatibility event translation
export { AcpLegacyEventTranslator, normalizeAcpMode } from "./acp-legacy-events";
export type { AcpContentBlock, AcpPermissionRequest, AcpPlanEntry, AcpSessionNotification, AcpSessionUpdate, AcpToolCallContent, AcpTranslateOptions } from "./acp-legacy-events";

// Types
export type {
  ApprovalResponse,
  ApprovalResult,
  AgentMode,
  ApprovalOption,
  ContentPart,
  TokenUsage,
  DisplayBlock,
  CommandBlock,
  FileOpBlock,
  FileContentBlock,
  UrlFetchBlock,
  SearchBlock,
  InvocationBlock,
  BackgroundTaskBlock,
  ToolCall,
  ToolCallPart,
  ToolResult,
  TurnBegin,
  StepBegin,
  StatusUpdate,
  ApprovalRequestPayload,
  PlanEntry,
  Plan,
  ConfigOption,
  ConfigOptionUpdate,
  AvailableCommand,
  AvailableCommandsUpdate,
  SubagentEvent,
  StreamEvent,
  LegacyWireEvent,
  LegacyWireRequest,
  LegacyStreamEvent,
  RunResult,
  ModelConfig,
  MCPServerConfig,
  KimiConfig,
  SessionOptions,
  SessionInfo,
  ContextRecord,
} from "./schema";

// Schemas
export {
  ContentPartSchema,
  DisplayBlockSchema,
  ToolCallSchema,
  ToolResultSchema,
  PlanSchema,
  ConfigOptionUpdateSchema,
  AvailableCommandsUpdateSchema,
  RunResultSchema,
  parseEventPayload,
  parseRequestPayload,
} from "./schema";
