// Client-side types — re-export server DTOs (type-only cross-package import).
// The server's `agent-record-types.ts` is the single source of truth for
// all session / agent / wire shapes.

export type {
  SessionSummary,
  SessionDetail,
  AgentInfo,
  SessionHealth,
  WireResponse,
  WireLine,
  ApiError,
  AgentRecord,
  ContextMessage,
  PromptOrigin,
  TokenUsage,
  PermissionMode,
  LoopRecordedEvent,
  ContentPart,
  Message,
  ToolCall,
} from '../../server/src/lib/agent-record-types';

export interface DeleteSessionResponse {
  sessionId: string;
  deleted: true;
}
