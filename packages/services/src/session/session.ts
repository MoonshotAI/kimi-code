/**
 * `ISessionService` — daemon-facing session CRUD interface.
 *
 * Wraps `ICoreProcessService.rpc.{createSession, listSessions, closeSession,
 * updateSessionMetadata}` and adapts agent-core's camelCase + number
 * timestamps to the protocol's snake_case + ISO 8601 `Z` shape (see SCHEMAS.md
 * §2). Other services in `@moonshot-ai/services` (messages, prompts, ...)
 * inherit this camelCase ↔ snake_case + number ↔ ISO pattern.
 *
 * **Why a service layer**: REST handlers in `@moonshot-ai/daemon` are
 * disallowed from importing `@moonshot-ai/kimi-code-sdk` (anti-corruption
 * test). Routes call `accessor.get(ISessionService).<method>(...)`; the
 * adapter is here.
 *
 * **CoreAPI shape gap**: agent-core does NOT expose `getSession(id)` returning
 * a full `SessionSummary` — `getSessionMetadata` returns the smaller
 * `SessionMeta` shape. `get(id)` is implemented via `listSessions({})` +
 * filter, throwing `SessionNotFoundError` (→ 40401) when the id is absent.
 * See `SessionService` for details + the gap documentation.
 *
 * **Adapter helpers**: `toProtocolSession` is co-located here.
 *
 * **DI wiring**: this class takes `ICoreProcessService` via ctor positional
 * arg. `defaultServicesModule()` adds a `SyncDescriptor(SessionService)`
 * entry, but the container has no ctor-arg DI, so the daemon's `start.ts`
 * wires it via
 * `ix.createInstance(SessionService, a.get(ICoreProcessService))` then
 * `services.set(ISessionService, instance)` — same pattern as
 * `CoreProcessService` itself. The descriptor entry is the canonical
 * declaration; the daemon's manual wiring is the runtime path.
 *
 * **Anti-corruption**: this file imports from `@moonshot-ai/agent-core` only
 * for type-only `SessionSummary` / `SessionMeta`. Runtime calls go through
 * `ICoreProcessService.rpc.<method>`, not direct CoreAPI consumption.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';
import type { Event } from '@moonshot-ai/agent-core/base/common/event';
import type { SessionMeta, SessionSummary } from '@moonshot-ai/agent-core';
import {
  emptySessionUsage,
  type CompactSessionRequest,
  type CompactSessionResponse,
  type CursorQuery,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatusResponse,
  type SessionUpdate,
} from '@moonshot-ai/protocol';

/**
 * Listing query — `before_id`/`after_id` + `page_size` mutual exclusivity is
 * already enforced by `cursorQuerySchema`. The service layer adds an optional
 * status filter the daemon layer parses out of the REST query string, and an
 * optional `workDir` filter for the `?workspace_id=` fast path (the daemon
 * route layer resolves `workspace_id → workspace.root` and sets `workDir`).
 */
export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
  /**
   * When set, the underlying `core.rpc.listSessions({workDir})` path uses
   * agent-core's `listWorkDir` (readdir-based) instead of a full `listAll`.
   * Daemon-route caller is responsible for resolving the workspace_id to its
   * registered root before populating this.
   */
  workDir?: string;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;

  /**
   * `POST /v1/sessions` — create a new session. Requires `metadata.cwd`
   * (agent-core's `createSession` calls `requiredWorkDir`; missing cwd ⇒ throw).
   */
  create(input: SessionCreate): Promise<Session>;

  /**
   * `GET /v1/sessions` — list sessions. Cursor pagination is applied
   * client-side over `core.rpc.listSessions({})` (the CoreAPI surface
   * doesn't take a cursor today). Default
   * `page_size = 20` per REST.md §1.6 is applied at the route layer, not here.
   */
  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  /**
   * `GET /v1/sessions/{id}` and `GET /v1/sessions/{id}/profile` — single
   * session by id. Implemented as `listSessions({}) + .find(id)`; throws
   * `SessionNotFoundError` (→ 40401) when not found.
   */
  get(id: string): Promise<Session>;

  /**
   * `POST /v1/sessions/{id}/profile` — update session mutable properties.
   * Backed by `updateSessionMetadata` for metadata changes; `title` writes
   * through the same path (mapped onto agent-core's `SessionMeta.title`).
   * `agent_config.model` is dispatched to `core.rpc.setModel` when present.
   * Returns the post-update Session.
   */
  update(id: string, input: SessionUpdate): Promise<Session>;

  /**
   * `POST /v1/sessions/{id}:fork` — create a new persisted session from an
   * idle source session and return the fork.
   */
  fork(id: string, input: SessionFork): Promise<Session>;

  /**
   * `GET /v1/sessions/{id}/children` — list direct child sessions whose
   * metadata points at the parent session.
   */
  listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  /**
   * `POST /v1/sessions/{id}/children` — create a persisted child session from
   * the parent session and return the child.
   */
  createChild(id: string, input: SessionChildCreate): Promise<Session>;

  /**
   * `DELETE /v1/sessions/{id}` — close (= soft-delete in v1) the session.
   * Backed by `bridge.rpc.closeSession({sessionId})`. CoreAPI does not
   * surface a hard delete; the daemon currently conflates close == delete.
   *
   * Returns `{ deleted: true }` envelope shape per REST §3.3.
   */
  getStatus(id: string): Promise<SessionStatusResponse>;

  compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse>;

  /**
   * `DELETE /v1/sessions/{id}` — close (= soft-delete in v1) the session.
   *   Backed by `bridge.rpc.closeSession({sessionId})`. CoreAPI does not
   *   surface a hard delete; the daemon currently conflates close == delete.
   *
   *   Returns `{ deleted: true }` envelope shape per REST §3.3.
   */
  delete(id: string): Promise<{ deleted: true }>;

  /**
   * VSCode-style accessor for session-creation events. The listener fires
   * synchronously after the bridge RPC returns a new `Session`.
   *
   * Subscribing returns an `IDisposable`. Owners stash it via
   * `Disposable._register(svc.onDidCreate(handler))` so it tears down
   * with the owning service.
   */
  readonly onDidCreate: Event<{ session: Session }>;

  /**
   * VSCode-style accessor for session-close events. The listener fires
   * synchronously after `bridge.rpc.closeSession` resolves. Same
   * `IDisposable` contract as `onDidCreate`.
   */
  readonly onDidClose: Event<{ sessionId: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionService = createDecorator<ISessionService>('sessionService');

/**
 * Sentinel error class — daemon's route layer catches this and maps to
 * `code: 40401` (session.not_found). Other errors fall through to
 * `installErrorHandler` (→ 50001 internal).
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/**
 * Convert agent-core's `SessionSummary` + optional `SessionMeta` into the
 * protocol-level `Session` shape. The optional `meta` argument is the result
 * of `getSessionMetadata` — when present, its `title` / `custom` enrich the
 * baseline summary; when absent, defaults are used.
 *
 * `cwd` overrides apply in this priority order:
 *   1. `meta.custom.cwd` (set by daemon when update wrote a new cwd).
 *   2. `summary.metadata.cwd` (when caller-supplied during create).
 *   3. `summary.workDir` (agent-core canonical field).
 *
 * `workspace_id` is ALWAYS derived from `summary.workDir` via
 * `encodeWorkDirKey`, so every session round-trips to a stable workspace
 * key. If the daemon has never seen a `POST /workspaces` for that wd-key
 * the id simply won't appear in the workspaces list; the session still has
 * an id the front-end can group on.
 *
 * The merged `Session.metadata` keeps `cwd` plus persistent custom metadata
 * from the summary and live `meta.custom` when available (excluding
 * daemon-internal `goal` plumbing — that's not protocol surface).
 */
export function toProtocolSession(
  summary: SessionSummary,
  meta?: SessionMeta | undefined,
): Session {
  const summaryMetadata = (summary.metadata ?? {}) as Record<string, unknown>;
  const customMetadata = (meta?.custom ?? {}) as Record<string, unknown>;
  const cwd =
    (typeof customMetadata['cwd'] === 'string' && customMetadata['cwd']) ||
    (typeof summaryMetadata['cwd'] === 'string' && summaryMetadata['cwd']) ||
    summary.workDir;

  // Strip the internal "goal" key — that's daemon-side runtime state, not
  // protocol surface (SCHEMAS §2 doesn't expose it).
  const { goal: _dropSummaryGoal, ...summaryWithoutGoal } = summaryMetadata;
  const { goal: _dropCustomGoal, ...customWithoutGoal } = customMetadata;

  const mergedMetadata: Session['metadata'] = {
    ...summaryWithoutGoal,
    ...customWithoutGoal,
    cwd,
  };

  const title = meta?.title ?? summary.title ?? '';
  const workspaceId = encodeWorkDirKey(summary.workDir);

  return {
    id: summary.id,
    workspace_id: workspaceId,
    title,
    created_at: new Date(summary.createdAt).toISOString(),
    updated_at: new Date(summary.updatedAt).toISOString(),
    status: 'idle',
    metadata: mergedMetadata,
    agent_config: {
      // CoreAPI doesn't surface a session's effective model on the listSessions
      // path; we leave it empty because there is no current source for the
      // effective model on this path. Empty string keeps the schema valid for
      // consumers that only inspect known keys.
      model: '',
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}
