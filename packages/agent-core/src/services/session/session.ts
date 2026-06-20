import { createDecorator } from '../../di';
import { encodeWorkDirKey } from '../../session/store';
import type { Event } from '../../base/common/event';
import type { SessionSummary } from '../../rpc';
import type { SessionMeta } from '../../session';
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
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
  workDir?: string;
  includeArchive?: boolean;
}

/**
 * Scope over which the `SessionIndex` read model lists / counts / searches.
 *
 * These mirror the four list surfaces the RPC boundary exposes today
 * (global list, per-workspace, per-workDir, children-of-parent) so the
 * upcoming `SessionQueryService` (M1.3) can route each through one index.
 *
 * Field names line up with what `SessionSummary` actually carries:
 * - `workspace.workspaceId` matches `encodeWorkDirKey(summary.workDir)`
 *   (the workspace id is derived from `workDir`, not stored on the summary).
 * - `workDir.workDir` matches `summary.workDir` directly.
 * - `children.parentId` matches `summary.metadata['parent_session_id']`
 *   (paired with `metadata['child_session_kind'] === 'child'`), mirroring
 *   `SessionService.listChildren`.
 */
export type SessionQueryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'workDir'; readonly workDir: string }
  | { readonly kind: 'children'; readonly parentId: string };

/** Archived-row visibility for index reads. Defaults to `'exclude'`. */
export type SessionIndexArchiveVisibility = 'exclude' | 'include' | 'only';

/** Sortable summary fields. All exist on `SessionSummary`. */
export type SessionIndexOrderBy = 'updatedAt' | 'createdAt' | 'title';

export type SessionIndexOrderDirection = 'asc' | 'desc';

/**
 * Read options shared by `ISessionIndex.list` / `count` / `search`.
 *
 * Archive visibility, ordering, and pagination are implemented in exactly
 * one place (the index); callers only describe what they want.
 *
 * `cursor` / `limit` mirror the protocol `CursorQuery` shape
 * (`before_id` / `after_id` / `page_size`): `cursor` is the exclusive
 * after-id of the last item on the previous page, and `limit` caps the
 * number of rows returned.
 */
export interface SessionIndexListOpts {
  readonly archived?: SessionIndexArchiveVisibility;
  readonly orderBy?: SessionIndexOrderBy;
  readonly orderDirection?: SessionIndexOrderDirection;
  /** Exclusive after-id cursor: return rows sorted after this id. */
  readonly cursor?: string;
  /** Maximum number of rows to return. */
  readonly limit?: number;
}

/**
 * Read-model summary index for sessions.
 *
 * Holds one `SessionSummary` row per session id and serves list / count /
 * search across the four `SessionQueryScope`s. It is a read model, not
 * truth: writers keep it in sync via `upsert` / `remove`. It is NOT a
 * `*Service` DI singleton — the `SessionQueryService` facade (M1.3) owns
 * and populates the instance.
 */
export interface ISessionIndex {
  /** Insert or replace the summary row for `summary.id`. */
  upsert(summary: SessionSummary): void;

  /** Drop the summary row for `id`. No-op when absent. */
  remove(id: string): void;

  /** Look up a single summary by id. */
  get(id: string): SessionSummary | undefined;

  /** List summaries in `scope`, applying visibility / ordering / pagination. */
  list(scope: SessionQueryScope, opts: SessionIndexListOpts): SessionSummary[];

  /** Count summaries in `scope` (visibility applies; pagination does not). */
  count(scope: SessionQueryScope, opts?: SessionIndexListOpts): number;

  /** Search summaries in `scope` by title (case-insensitive substring). */
  search(scope: SessionQueryScope, query: string, opts?: SessionIndexListOpts): SessionSummary[];
}

export interface SessionClientTelemetry {
  id?: string;
  name?: string;
  version?: string;
  uiMode?: string;
}

export interface SessionCreateOptions {
  client?: SessionClientTelemetry;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;

  create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session>;

  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  get(id: string): Promise<Session>;

  update(id: string, input: SessionUpdate): Promise<Session>;

  fork(id: string, input: SessionFork): Promise<Session>;

  listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  createChild(id: string, input: SessionChildCreate): Promise<Session>;

  getStatus(id: string): Promise<SessionStatusResponse>;

  compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse>;

  undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse>;

  archive(id: string): Promise<{ archived: true }>;

  readonly onDidCreate: Event<{ session: Session }>;

  readonly onDidClose: Event<{ sessionId: string }>;
}

export interface SessionSearchQuery extends SessionListQuery {
  /** Case-insensitive substring matched against the session title. */
  readonly q: string;
}

/**
 * Read-model facade for sessions.
 *
 * Serves list / count / search across the `SessionQueryScope`s from the
 * `SessionIndex` (M1.2) read model. It is a pure query surface: it never
 * mutates session state and never resumes an agent — hydration is limited to
 * cold reads (`listSessions` + per-row `getSessionMetadata`). The command
 * path (`ISessionService`) delegates its list surfaces here (M1.3) and will
 * drop them entirely in M7.1.
 */
export interface ISessionQueryService {
  readonly _serviceBrand: undefined;

  /** List sessions, honoring `workDir` / `includeArchive` / cursor / status. */
  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  /** List direct children of a parent session. */
  listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  /** List every session regardless of workDir (global scope). */
  listGlobal(query: SessionListQuery): Promise<PageResponse<Session>>;

  /** List sessions whose workDir maps to `workspaceId`. */
  listByWorkspace(workspaceId: string, query: SessionListQuery): Promise<PageResponse<Session>>;

  /** Count sessions in `scope` (defaults to global). */
  count(scope?: SessionQueryScope): Promise<number>;

  /** Search sessions by title within the scope implied by the query. */
  search(query: SessionSearchQuery): Promise<PageResponse<Session>>;
}

export const ISessionService = createDecorator<ISessionService>('sessionService');

export const ISessionQueryService = createDecorator<ISessionQueryService>('sessionQueryService');

export class SessionUndoUnavailableError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message = 'Nothing to undo in the active context.') {
    super(message);
    this.name = 'SessionUndoUnavailableError';
    this.sessionId = sessionId;
  }
}

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

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
    archived: summary.archived === true,
    metadata: mergedMetadata,
    agent_config: {
      model: '',
    },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}
