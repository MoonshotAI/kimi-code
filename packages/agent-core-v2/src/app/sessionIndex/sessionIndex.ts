/**
 * `sessionIndex` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: a backend-neutral
 * query facade over the set of persisted sessions (open or closed). It serves
 * recency-ordered pages, point lookups, and counts (`SessionSummary` data or
 * numbers — never filesystem paths or live handles). Writes (create /
 * archive) live in `sessionLifecycle` / `session`; the index is a read model.
 * Backends are deployment-specific (local filesystem today; database / query
 * store on a server). `remove` is the one write: it evicts a deleted
 * session's derived/cached state so `get` stops answering for the id — the
 * authoritative record (the session directory) is deleted by the caller
 * (`sessionLifecycle.delete`).
 *
 * Listings follow a canonical order — `updatedAt` descending, `id`
 * descending as the tie-break — and page with keyset cursors: `before` /
 * `after` take a session id and return the page strictly older / newer than
 * it; `Page.nextCursor` carries the id to pass as `before` for the next
 * older page. An unknown cursor id yields an empty, terminal page.
 *
 * Lifecycle (flag `persistence_minidb_readmodel`): the read model has an
 * explicit `prepare()` — `uninitialized → preparing → ready`, or `degraded`
 * when it must fall back to the authoritative store. `prepare()` is called
 * once by the composition root; read paths kick it lazily (single-flight)
 * when a host never did. `status()` exposes the state machine, the published
 * generation, and the cumulative degraded count.
 *
 * `ISessionIndexMirror` is the write side of the read model: `SessionMetadata`
 * records fresh summaries into a bounded, coalescing queue after the
 * authoritative document is durable, so user mutations never wait on the
 * derived store. Bound at App scope.
 */

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
