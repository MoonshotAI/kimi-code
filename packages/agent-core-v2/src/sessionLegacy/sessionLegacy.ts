/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session actions.
 *
 * Implements the legacy `/api/v1/sessions/{tail}` action contract (`fork` /
 * `compact` / `undo` / `abort` / `btw`) and the `/sessions/{id}/children`
 * endpoints (`createChild` / `listChildren`) on top of the native v2 services
 * (`ISessionLifecycleService`, `ISessionIndex`, `IAgentRPCService`,
 * `IFullCompaction`, `IPromptService`, …). The native services keep serving
 * `/api/v2` and are left untouched; this adapter exists only so clients of the
 * v1 server keep working against server-v2. Bound at Core scope — it is a
 * stateless dispatcher that resolves the target session/agent per call.
 */

import type {
  CompactSessionRequest,
  CompactSessionResponse,
  CreateSessionChildRequest,
  ForkSessionRequest,
  SessionAbortResponse,
  SessionStatus,
  StartBtwSessionResponse,
  UndoSessionRequest,
} from '@moonshot-ai/protocol';

import type { ContextMessage } from '#/contextMemory';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Raw fields the route projects into the wire `Session` (via `toWireSession`).
 * Kept protocol-free so the edge projection stays in the server layer.
 */
export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  /** Workspace root — used as `cwd` when projecting to the wire `Session`. */
  readonly root: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

/** Plain-data mirror of the protocol `SessionStatusResponse`. */
export interface SessionStatusData {
  readonly status: SessionStatus;
  readonly model?: string;
  readonly thinking_level: string;
  readonly permission: string;
  readonly plan_mode: boolean;
  readonly swarm_mode: boolean;
  readonly context_tokens: number;
  readonly max_context_tokens: number;
  readonly context_usage: number;
}

export interface UndoResult {
  /** Post-undo context history; the route projects it into the message page. */
  readonly history: readonly ContextMessage[];
  readonly status: SessionStatusData;
}

/** Query mirror of the v1 `GET /sessions/{id}/children` cursor + status filter. */
export interface SessionChildrenQuery {
  readonly before_id?: string;
  readonly after_id?: string;
  readonly page_size?: number;
  readonly status?: SessionStatus;
}

/** Page of child sessions, projected by the route into the wire `Page<Session>`. */
export interface SessionChildrenPage {
  readonly items: readonly SessionWireFields[];
  readonly has_more: boolean;
}

export interface ISessionLegacyService {
  readonly _serviceBrand: undefined;
  fork(sessionId: string, body: ForkSessionRequest): Promise<SessionWireFields>;
  createChild(sessionId: string, body: CreateSessionChildRequest): Promise<SessionWireFields>;
  listChildren(sessionId: string, query: SessionChildrenQuery): Promise<SessionChildrenPage>;
  compact(sessionId: string, body: CompactSessionRequest): Promise<CompactSessionResponse>;
  undo(sessionId: string, body: UndoSessionRequest): Promise<UndoResult>;
  abort(sessionId: string): Promise<SessionAbortResponse>;
  startBtw(sessionId: string): Promise<StartBtwSessionResponse>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
