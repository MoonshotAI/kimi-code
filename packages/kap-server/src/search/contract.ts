/**
 * `search` module — global message search contract (temporary feature, lives
 * in kap-server until it graduates into agent-core-v2).
 *
 * The API shape borrows from Lark/Feishu's IM message endpoints:
 *   - a `container` concept (`container_id_type` + `container_id`) — here a
 *     message hangs under a session (and optionally one agent inside it);
 *     omitting `container` searches globally;
 *   - opaque cursor pagination (`pageSize` + `pageToken` + `hasMore`) where
 *     the query conditions may NOT change mid-pagination — the token encodes
 *     a fingerprint of the conditions and a mismatch is a parameter error;
 *   - POST + JSON body for search (a query operation, not a resource fetch);
 *   - an explicit sort enum (`sort_type`) and a time-range filter.
 *
 * This file is the single source of truth for the request/response shapes,
 * shared by the Service interface (`searchService.ts`) and the REST zod
 * schemas (`protocol/rest-search.ts`).
 *
 * Pagination & generation semantics (v2 page tokens):
 *   - Tokens are keyset cursors: they carry the sort boundary of the last
 *     returned hit — (time, key) for time sorts and literal mode, (score,
 *     time, key) for score sort — never an offset, so a deep page costs
 *     proportionally to pageSize, not to the full match set.
 *   - Index-route tokens also pin the index generation they were issued by.
 *     The generation changes when the published base is swapped (initial
 *     open, a read-only full reopen, a reindex) or when a sync pass REPLACED
 *     already-indexed documents (a shrunk/rebuilt wire file rescan, a title
 *     overwrite). A token from an older generation fails with
 *     `invalid_page_token` — the client's signal to restart the search.
 *   - Weak consistency within one generation: additive indexing (new
 *     sessions, appended wire bytes) and deletions do NOT change the
 *     generation, and keyset pagination stays exact under them for time
 *     sorts (a hit added after the cursor sorts behind it and is simply not
 *     surfaced — snapshot-at-first-page semantics). Score sorts may drift
 *     because IDF depends on corpus size; restart the search for a fresh
 *     ranking.
 *   - Legacy v1 offset tokens (pre-versioning, `{f, s}`) are still accepted
 *     for a transition window and answered with offset semantics; the
 *     response always issues a v2 keyset token back, so clients upgrade on
 *     the next page.
 */

// ---- request ---------------------------------------------------------------

export interface GlobalSearchQuery {
  /** Keyword(s), required. */
  readonly query: string;
  /**
   * 'terms' (default) — the word-level full-text index; 'literal' — exact
   * substring match over the n-gram index (case-insensitive, NFKC-folded;
   * needs at least 2 normalized characters). `op`/`sort` only apply to
   * 'terms'; literal hits carry score 0 and sort by time desc.
   */
  readonly mode?: 'terms' | 'literal';
  /** Term combination, default AND. */
  readonly op?: 'AND' | 'OR';
  /** Omit to search across every session. */
  readonly container?: {
    readonly sessionId?: string;
    readonly agentId?: string;
  };
  /** Restrict to one document role. */
  readonly role?: 'user' | 'assistant' | 'title';
  /** Epoch ms, inclusive bounds. */
  readonly startTime?: number;
  readonly endTime?: number;
  /** Default 'score' (relevance). */
  readonly sort?: 'score' | 'time_desc' | 'time_asc';
  /** Default 20, max 50. */
  readonly pageSize?: number;
  /** Opaque cursor from the previous page; omit for the first page. */
  readonly pageToken?: string;
}

// ---- errors ----------------------------------------------------------------

export type GlobalSearchErrorReason =
  | 'invalid_query'
  | 'invalid_page_token'
  | 'readonly_index'
  | 'index_unavailable';

/**
 * Service-level error with a machine-readable reason. Lives in the contract
 * (not the service module) so the search-index core — which also runs inside
 * the search worker thread — can raise it without importing the service.
 */
export class GlobalSearchError extends Error {
  constructor(
    readonly reason: GlobalSearchErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalSearchError';
  }
}

// ---- response --------------------------------------------------------------

export interface GlobalSearchHit {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** 'main' or a subagent id. */
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'title';
  /** ~80-char window around the first hit term, generated server-side. */
  readonly snippet: string;
  /** Epoch ms of the wire record (session `updatedAt` for title docs). */
  readonly time: number;
  /**
   * 0-based turn ordinal in the transcript view (same numbering as the
   * `before_turn` pagination cursor of `GET /sessions/{id}/transcript` — the
   * turn lives at `t<turn>`). The numbering is monotonic over the wire
   * journal: compaction / clear do not renumber. Absent for title hits and
   * for docs indexed before turn tracking; docs whose turns were later cut by
   * an undo keep their pre-undo ordinal (no longer jumpable).
   */
  readonly turn?: number;
  /**
   * Transcript step id (`t<turn>.<step>`, e.g. `t3.2`) of the step that
   * produced this assistant text — the same id space as the transcript model
   * (`packages/transcript` `model/ids.ts`), so a client can jump straight to
   * the step. The ordinal is the engine's live step numbering (the wire
   * record's `step` field); vacuous steps own no document, so ordinals may
   * have gaps. Present only for assistant-role hits indexed after step
   * tracking existed; docs whose turns were later cut by an undo keep their
   * pre-undo id (no longer jumpable — same deviation as `turn`).
   */
  readonly stepId?: string;
  readonly score: number;
}

export interface GlobalSearchIndexState {
  /**
   * building — the first full sync has not finished yet, or the index base
   * is (re)building after a no-generation fallback recovery — results may
   * be incomplete; ready — a full sync completed in this process;
   * readonly — another process holds the index write lock, this process only
   * reads (catching up from the WAL in the background).
   */
  readonly state: 'building' | 'ready' | 'readonly';
  /** Progress counters behind `state`. */
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
  /**
   * True when the served page comes from a generation the service already
   * knows to be behind: a newer index version was detected on disk
   * (read-only refresh pending) or a background sync is in flight/queued.
   * The results are still valid — just potentially not the freshest.
   */
  readonly stale?: boolean;
  /**
   * Set when the last background refresh/sync/reindex FAILED and the page is
   * served from the previous (stale) generation: the error message, for
   * observability. Absent when the last refresh succeeded.
   */
  readonly degraded?: string;
}

/**
 * Which backend served the page:
 *   - 'index' — the minidb full-text index (the default; always used when the
 *     container session is not live in this process);
 *   - 'live' — an in-memory scan of the live session's `TranscriptStore`
 *     (container-scoped queries on a session resumed in this process).
 * Scores are only comparable within one source.
 */
export type GlobalSearchSource = 'live' | 'index';

/**
 * Why a page may miss real hits (the query was bounded, never silently
 * truncated):
 *   - 'candidate_cap' — the candidate set exceeded the confirmation cap, so
 *     confirmation stopped at the cap;
 *   - 'postings_budget' — the postings-visit budget stopped the index-side
 *     candidate scan early (hot term/n-gram), so candidates are a subset;
 *   - 'deadline' — the query's work budget (wall-clock deadline or processed
 *     text volume) ran out during matching/confirmation.
 * A page token from a changed index generation is NOT reported here — it
 * fails the request with `invalid_page_token` (see the file header).
 */
export type GlobalSearchIncomplete = 'candidate_cap' | 'postings_budget' | 'deadline';

export interface GlobalSearchPage {
  readonly items: GlobalSearchHit[];
  readonly hasMore: boolean;
  /** Present iff `hasMore`. */
  readonly pageToken?: string;
  readonly incomplete?: GlobalSearchIncomplete;
  readonly indexState: GlobalSearchIndexState;
  /**
   * The route that produced this page. The page token's fingerprint covers
   * it: a route flip mid-pagination (e.g. the session closed) invalidates
   * the token and the client must restart the search.
   */
  readonly source: GlobalSearchSource;
}
