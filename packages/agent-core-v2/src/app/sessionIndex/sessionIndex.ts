import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Page } from '#/persistence/interface/queryStore';

export const PARENT_SESSION_ID_KEY = 'parent_session_id';

export const CHILD_SESSION_KIND_KEY = 'child_session_kind';

export const CHILD_SESSION_KIND = 'child';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  /** Archive time (epoch ms); absent for sessions archived before the field
   *  existed — callers fall back to `updatedAt` for display. */
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface SessionListQuery {
  /**
   * Restrict to sessions persisted under any of these workspace ids. A single
   * workspace is `[id]`; callers resolving a legacy split bucket (one
   * directory, several id spellings — see `IWorkspaceAliases.resolveAliasIds`)
   * pass the whole alias set and get one merged listing. Absent lists every
   * bucket.
   */
  readonly workspaceIds?: readonly string[];
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly childOf?: string;
  /** Keyset cursor: the page strictly older than this session id. */
  readonly before?: string;
  /** Keyset cursor: the page strictly newer than this session id. */
  readonly after?: string;
}

export interface SessionCountQuery {
  readonly workspaceIds?: readonly string[];
  readonly includeArchived?: boolean;
}

export type SessionIndexState = 'uninitialized' | 'preparing' | 'ready' | 'degraded';

export interface SessionIndexStatus {
  readonly state: SessionIndexState;
  /** Published read-model generation; absent until the first projection. */
  readonly generation?: number;
  /** Why the index last entered `degraded` (authoritative fallback). */
  readonly reason?: string;
  /** How many times the index entered `degraded` in this process. */
  readonly degradedCount: number;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  /**
   * Open the read model and make it servable: open the query store, create
   * the schema, restore the published generation (running the initial
   * projection when none exists), and start background reconciliation.
   * Single-flight; a no-op when the read-model flag is off.
   */
  prepare(options?: { deadlineMs?: number }): Promise<SessionIndexStatus>;
  status(): SessionIndexStatus;
  get(id: string): Promise<SessionSummary | undefined>;
  /** Recency-ordered keyset page over the persisted session set. */
  listRecent(query: SessionListQuery): Promise<Page<SessionSummary>>;
  /** Materialized count over the given workspace-id set. */
  count(query: SessionCountQuery): Promise<number>;
  /**
   * The one write: evict a deleted session's derived/cached state so `get`
   * stops answering for the id — the authoritative record (the session
   * directory) is deleted by the caller (`sessionLifecycle.delete`).
   */
  remove(id: string): Promise<void>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');

export interface ISessionIndexMirror {
  readonly _serviceBrand: undefined;

  /**
   * Enqueue the latest summary of a session for mirroring into the read
   * model. Synchronous, bounded, and coalescing (only the newest summary per
   * session is kept); never throws — failures stay dirty and are healed by
   * reconciliation.
   */
  record(summary: SessionSummary): void;
  /** Summaries accepted but not yet flushed (read-your-writes window). */
  pending(): readonly SessionSummary[];
  /**
   * Forget a session on the delete path: drop any queued summary and wait
   * out an in-flight flush that may still carry it, so the caller's
   * follow-up query-store delete is not resurrected by the mirror.
   */
  evict(id: string): Promise<void>;
  /** Flush everything currently queued; resolves with the queue empty. */
  drain(): Promise<void>;
}

export const ISessionIndexMirror: ServiceIdentifier<ISessionIndexMirror> =
  createDecorator<ISessionIndexMirror>('sessionIndexMirror');
