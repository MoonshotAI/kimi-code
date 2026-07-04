/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session actions.
 *
 * Implements the legacy `/api/v1/sessions/{tail}` action contract (`fork` /
 * `compact` / `undo` / `abort` / `btw`) and the `/sessions/{id}/children`
 * endpoints (`createChild` / `listChildren`) on top of the native v2 services
 * (`ISessionLifecycleService`, `ISessionIndex`, `IAgentRPCService`,
 * `IAgentFullCompactionService`, `IAgentPromptService`, …). The native services keep serving
 * `/api/v2` and are left untouched; this adapter exists only so clients of the
 * v1 server keep working against server-v2. Bound at App scope — it is a
 * stateless dispatcher that resolves the target session/agent per call.
 */

import type {
  ArchiveSessionResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  CreateSessionChildRequest,
  ForkSessionRequest,
  SessionAbortResponse,
  SessionStatus,
  UndoSessionRequest,
  UndoSessionResponse,
} from '@moonshot-ai/protocol';

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
  undo(sessionId: string, body: UndoSessionRequest): Promise<UndoSessionResponse>;
  abort(sessionId: string): Promise<SessionAbortResponse>;
  archive(sessionId: string): Promise<ArchiveSessionResponse>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
