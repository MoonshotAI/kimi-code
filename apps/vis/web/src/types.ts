// Client-side types — re-export server DTOs (type-only cross-package import).
// The server's `agent-record-types.ts` is the single source of truth for
// all session / agent / wire shapes.

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
} from '../../server/src/lib/agent-record-types';

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

/**
 * Shape returned by `GET /api/sessions/:id/context?agent=<agentId>`.
 *
 * Mirrors `ContextProjection` from context-projector, plus the `sessionId`
 * and `agentId` echoed by the route.
 */
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
