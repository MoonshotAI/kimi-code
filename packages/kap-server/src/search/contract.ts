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
   * building — the first full sync has not finished yet, results may be
   * incomplete; ready — a full sync completed in this process;
   * readonly — another process holds the index write lock, this process only
   * reads (incrementally catching up from the WAL before each search).
   */
  readonly state: 'building' | 'ready' | 'readonly';
  /** Progress counters behind `state`. */
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
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

export interface GlobalSearchPage {
  readonly items: GlobalSearchHit[];
  readonly hasMore: boolean;
  /** Present iff `hasMore`. */
  readonly pageToken?: string;
  /**
   * 'candidate_cap' — the literal-mode candidate set exceeded the cap, so
   * confirmation was truncated and the page may miss real hits.
   */
  readonly incomplete?: 'candidate_cap';
  readonly indexState: GlobalSearchIndexState;
  /**
   * The route that produced this page. The page token's fingerprint covers
   * it: a route flip mid-pagination (e.g. the session closed) invalidates
   * the token and the client must restart the search.
   */
  readonly source: GlobalSearchSource;
}
