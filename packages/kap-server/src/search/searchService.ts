/**
 * `search` module — `IGlobalSearchService` implementation (temporary feature,
 * lives in kap-server until it graduates into agent-core-v2).
 *
 * Cross-session full-text search over user messages, assistant text and
 * session titles, backed by a single minidb database at
 * `<homeDir>/search-index`.
 *
 * Request/sync split — "requests serve a published generation, never wait":
 *   - A search request reads the currently published index generation and
 *     returns immediately — with `building` semantics when no generation has
 *     been published yet. It may KICK a background sync/refresh but never
 *     awaits one.
 *   - The background coordinator (single-flight + debounce + one queued
 *     follow-up) detects authoritative changes (session/wire enumeration),
 *     projects them incrementally, and publishes new checkpoints; a sync
 *     that REPLACED indexed documents (shrink rescan, title overwrite) also
 *     bumps the generation, invalidating older page tokens.
 *   - Refresh/sync failures are recorded in `lastRefreshError` and surface
 *     as `indexState.degraded` while the previous generation keeps serving.
 *
 * Execution hosts (stage 4 worker isolation):
 *   - Everything that touches the search-index MiniDb lives in the
 *     host-agnostic core (`indexCore.ts`). The service never opens the
 *     global search MiniDb itself.
 *   - WORKER host (default): the core runs inside a dedicated worker thread
 *     (`worker/entry.ts`), driven over RPC by `worker/host.ts`
 *     (`SearchWorkerHost`) — generation loads, WAL replays, sync passes and
 *     query execution never share this process's event loop. A worker that
 *     fails to start or dies mid-flight yields recognizable degraded
 *     responses (never a silent fallback onto the main thread); the
 *     `search_worker` experimental flag (`KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER`,
 *     default ON) is the explicit rollback switch back to the inline host.
 *   - INLINE host (rollback / tests): the same core runs in-process.
 *   - The main thread keeps only: query normalization, page-token
 *     encode/decode, the sync coordinator (debounce/single-flight over the
 *     backend's sync), the live-transcript route, and hit projection.
 *
 * Concurrency model — "the lock is the election" (unchanged; the write lock
 * is now held by the worker thread on behalf of this process):
 *   - `MiniDb.open({ onLockFail: 'readonly' })`: the process that grabs the
 *     exclusive write lock becomes the indexer (build + incremental sync);
 *     every other process opens read-only and never rescans wire files.
 *   - A read-only instance checks a cheap file fingerprint (db.wal /
 *     db.snapshot / db.textindexes.json) per search: unchanged → serve the
 *     in-memory view; changed → refresh in the BACKGROUND (WAL pure-append →
 *     `MiniDb.catchUpFromWal` incremental replay; anything else → open the
 *     replacement db first, then swap — a failed reopen keeps the stale
 *     generation servable). When the indexer dies, the next opener takes the
 *     lock and becomes the new indexer.
 *
 * Registration: this module is side-effect-imported by `start.ts` BEFORE
 * `bootstrap()` runs, so the module-level `registerScopedService` below lands
 * in the DI registry in time and the service is instantiated (App scope,
 * OnScopeCreated) with the rest — which also exposes it on the `/api/v1/debug`
 * reflection surface as `globalSearch` with zero extra code.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import {
  createDecorator,
  IBootstrapService,
  IFlagService,
  ILogService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  registerFlagDefinition,
  registerScopedService,
  sessionDirOf,
  workspacePersistenceScope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { normalizeLiteral, tokenize } from '@moonshot-ai/minidb';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import {
  GlobalSearchError,
  type GlobalSearchHit,
  type GlobalSearchIndexState,
  type GlobalSearchPage,
  type GlobalSearchQuery,
} from './contract';
import { MAX_DOC_TEXT_CHARS, type MessageDoc, type TitleDoc } from './docs';
import {
  SearchIndexCore,
  type CoreIndexView,
  type CoreLifecycleReport,
  type CoreSearchParams,
  type CoreSearchResult,
  type CoreStatus,
  type CoreSyncOutcome,
  type SyncSessionInput,
} from './indexCore';
import {
  boundaryOf,
  decodePageToken,
  encodePageToken,
  matchDocs,
  paginateRows,
  type MatchedRow,
  type NormalizedQuery,
  type SearchBudgets,
} from './match';
import { makeSnippet } from './snippet';
import { SearchWorkerError, SearchWorkerHost, dropLiveLockToken, noteLiveLockToken } from './worker/host';

export { GlobalSearchError } from './contract';
export type { GlobalSearchErrorReason } from './contract';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_DIR_NAME = 'search-index';
/** Sessions are listed in pages of this size. */
const SESSION_PAGE_SIZE = 500;

// -- query budgets (service knobs; the defaults are the production values) ----

/** Max distinct query terms in terms mode. */
const MAX_QUERY_TERMS = 32;
/** Max literal-query length in normalized code points (bounds n-gram terms). */
const MAX_LITERAL_QUERY_CHARS = 1_024;
/**
 * Max posting entries the index may visit for one query (both modes). A hot
 * term/n-gram whose postings overflow the budget contributes a prefix and
 * the page is flagged `incomplete: 'postings_budget'` — the budget applies
 * at the postings/score stage, not just at final confirmation.
 */
const MAX_POSTINGS_VISITS = 250_000;
/** Wall-clock budget for the in-memory match/confirm phase of one query. */
const QUERY_DEADLINE_MS = 500;
/** Max document text processed by literal confirmation per query (UTF-16
 *  code units) — the backstop for pathological huge-document corpora. */
const QUERY_TEXT_BUDGET_CHARS = 16_000_000;
/** Upper bound for text-index candidates handed to the scoring map / query. */
const MAX_TEXT_HITS = 100_000;
/**
 * Upper bound for literal-mode n-gram candidates handed to the confirmation
 * pass (a store `get` plus a substring scan each — pure CPU). Beyond the cap
 * the page is truncated and flagged `incomplete: 'candidate_cap'`.
 */
const LITERAL_CANDIDATE_CAP = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Experimental flag (the rollback switch for the worker host)
// ---------------------------------------------------------------------------

/**
 * `search_worker` — run the global search index in a dedicated worker
 * thread (default ON). Disable via `KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER=false`
 * or the `[experimental]` config section to fall back to the in-process
 * (inline) host. Read once at service construction.
 */
export const SEARCH_WORKER_FLAG_ID = 'search_worker';

registerFlagDefinition({
  id: SEARCH_WORKER_FLAG_ID,
  title: 'search worker isolation',
  description:
    'Run the global search-index MiniDB (open, WAL replay, sync, queries) in a dedicated worker thread instead of the server main thread.',
  env: 'KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER',
  default: true,
  surface: 'core',
});

// ---------------------------------------------------------------------------
// Disposal drain (unchanged contract with start.ts)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget close promises produced by `dispose()` (DI disposal is
 * synchronous). The server shutdown path awaits these via
 * `drainGlobalSearchDisposals()` before the homeDir is released, so a
 * teardown `rm()` never races an in-flight backend close.
 */
const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  // Fixpoint loop (review #21): awaiting a batch of disposals can trigger
  // further dispose() calls — an embedder tearing down scopes concurrently —
  // which register NEW pending promises a one-shot Promise.all snapshot
  // would not wait for. Keep draining until the set is still empty at the
  // end of a wait.
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  /** Full rebuild: wipe the index and rescan every wire file. */
  reindex(): Promise<{ sessions: number; documents: number }>;
  /**
   * Diagnostic status (the `/api/v1/debug` surface reflects it). Never
   * throws: a backend that cannot answer (failed open, worker down) reports
   * a degraded lifecycle instead of rejecting. `lifecycle` is the aggregate
   * state machine (stage 5): stopped → opening → ready → building/degraded →
   * closing. NOTE the historical contract: the call may kick/await the
   * backend's open and read-only refresh — use `lifecycleReport()` for a
   * non-intrusive local read.
   */
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    /** Identity of the published base; bumps invalidate v2 page tokens. */
    generation: number;
    /** Last background refresh/sync/reindex failure, if serving stale. */
    degraded?: string;
    lifecycle: CoreLifecycleReport;
  }>;
  /**
   * Synchronous local lifecycle report (stage 5): never kicks an open, never
   * spawns the worker, never awaits. Answers the transitional states
   * (stopped/opening/degraded-backoff/closing) that status() would block on.
   */
  lifecycleReport(): CoreLifecycleReport;
  /**
   * Wire the live-transcript source for the in-memory search route. Called
   * once from the composition root (start.ts) after `TranscriptService` is
   * constructed; until then every search takes the index route.
   */
  setLiveTranscriptSource(source: LiveTranscriptSource): void;
}

export const IGlobalSearchService = createDecorator<IGlobalSearchService>('globalSearch');

/**
 * Live-transcript access behind the in-memory (live) search route.
 * Implemented by `TranscriptService` (`src/services/transcript/`); declared
 * here with only the three methods the route needs, so the search module
 * does not import the transcript service's dependency stack.
 */
export interface LiveTranscriptSource {
  /** Transcript store of a session live in this process; undefined when not in memory. */
  forSessionLive(sessionId: string): TranscriptStore | undefined;
  /** Resolves when the session's initial history backfill has landed. */
  whenReady(sessionId: string): Promise<void>;
  /** Replay one agent's persisted history into the live store (idempotent per agent). */
  ensureAgentHistory(sessionId: string, agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

function normalizeQuery(input: GlobalSearchQuery, maxQueryTerms: number): NormalizedQuery {
  const mode = input.mode ?? 'terms';
  // Literal matching is byte-exact (mod NFKC/case) — whitespace is part of
  // the query, so it is never trimmed.
  const query = mode === 'literal' ? input.query : input.query.trim();
  if (query.length === 0) {
    throw new GlobalSearchError('invalid_query', 'query must be a non-empty string');
  }
  const literalQuery = mode === 'literal' ? normalizeLiteral(query) : undefined;
  // NOTE: the <2-code-point gate for literal queries lives in the INDEX route
  // (`searchIndex`) — it is a constraint of the n-gram candidate index, not of
  // literal matching itself. The live route (pure in-memory scan) accepts any
  // non-empty literal query, down to a single code point.
  const termsQuery = mode === 'terms' ? [...new Set(tokenize(query))] : undefined;
  if (termsQuery !== undefined && termsQuery.length > maxQueryTerms) {
    throw new GlobalSearchError(
      'invalid_query',
      `query has too many terms (${termsQuery.length} > ${maxQueryTerms}); narrow it down`,
    );
  }
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new GlobalSearchError('invalid_query', 'pageSize must be an integer between 1 and 50');
  }
  return {
    query,
    mode,
    literalQuery,
    termsQuery,
    op: input.op ?? 'AND',
    container: input.container,
    role: input.role,
    startTime: input.startTime,
    endTime: input.endTime,
    sort: input.sort ?? 'score',
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Execution backends (worker RPC vs inline core)
// ---------------------------------------------------------------------------

/** The service's view of an execution host for the search-index core. */
export interface SearchBackend {
  /**
   * Synchronously stop accepting new background work (called from the
   * service's synchronous dispose() before any awaiting): in-flight passes
   * skip their remaining writes at the next gate check.
   */
  beginClose(): void;
  /**
   * Local, round-trip-free aggregate lifecycle (stage 5): the states a wedged
   * or not-yet-started backend must be able to report without being asked
   * (stopped/opening/degraded/closing). The full status() round trip refines
   * the up states (ready/building) with exact stats.
   */
  lifecycleSnapshot(): CoreLifecycleReport;
  ensureOpen(): Promise<unknown>;
  search(params: CoreSearchParams): Promise<CoreSearchResult>;
  sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome>;
  refresh(): Promise<unknown>;
  reindex(): Promise<unknown>;
  status(): Promise<CoreStatus>;
  dispose(): Promise<void>;
}

/** Rollback host: the search-index core running on the main thread. */
export class InlineSearchBackend implements SearchBackend {
  readonly core: SearchIndexCore;

  constructor(options: { indexDir: string; log: ILogService }) {
    // A fresh boot salt per service instance: page tokens never validate
    // across a service/process restart (the core's local generation counter
    // restarts from 0), mirroring the worker host's per-spawn salt. The held
    // lock token is registered process-wide so a worker-host peer's orphan
    // detector never mistakes this inline writer's lock for a dead worker's.
    this.core = new SearchIndexCore({
      ...options,
      bootSalt: randomUUID(),
      onLockToken: noteLiveLockToken,
    });
  }

  beginClose(): void {
    this.core.beginClose();
  }

  lifecycleSnapshot(): CoreLifecycleReport {
    return this.core.lifecycleState();
  }

  ensureOpen(): Promise<void> {
    return this.core.ensureOpen();
  }

  search(params: CoreSearchParams): Promise<CoreSearchResult> {
    return this.core.search(params);
  }

  sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome> {
    return this.core.sync(sessions);
  }

  refresh(): Promise<void> {
    return this.core.refresh();
  }

  reindex(): Promise<void> {
    return this.core.reindex();
  }

  status(): Promise<CoreStatus> {
    return this.core.status();
  }

  dispose(): Promise<void> {
    dropLiveLockToken(this.core.lockTokenView);
    return this.core.close();
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GlobalSearchService implements IGlobalSearchService {
  declare readonly _serviceBrand: undefined;

  /** Minimum interval between search-triggered sync passes (test knob). */
  syncDebounceMs = 2_000;

  /** Literal-mode candidate cap (test knob, see LITERAL_CANDIDATE_CAP). */
  literalCandidateCap = LITERAL_CANDIDATE_CAP;

  /** Terms-mode candidate cap (test knob, see MAX_TEXT_HITS). */
  maxTextHits = MAX_TEXT_HITS;

  /** Postings-visit budget per query (test knob, see MAX_POSTINGS_VISITS). */
  postingsVisitBudget = MAX_POSTINGS_VISITS;

  /** Match/confirm wall-clock budget per query (test knob). */
  queryDeadlineMs = QUERY_DEADLINE_MS;

  /** Literal-confirmation text-volume budget per query (test knob). */
  queryTextBudgetChars = QUERY_TEXT_BUDGET_CHARS;

  /** Max distinct query terms in terms mode (test knob). */
  maxQueryTerms = MAX_QUERY_TERMS;

  private readonly backend: SearchBackend;
  private syncPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private lastSyncStartedAt = 0;
  private summaries = new Map<string, SessionSummary>();
  private disposed = false;
  /** Set while `reindex()` swaps the db — syncs started meanwhile are no-ops. */
  private reindexing = false;
  /** Live-transcript source for the in-memory route; null until start.ts wires it. */
  private liveSource: LiveTranscriptSource | null = null;
  /** One queued follow-up pass behind the in-flight one (backpressure). */
  private syncQueued = false;
  /** Trailing-pass timer behind the debounce window. */
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last background sync/reindex/worker failure — surfaced as degraded. */
  private lastRefreshError: { at: number; message: string } | null = null;
  /** Set when dispose()'s async drain finished — lifecycle 'stopped'. */
  private drainSettled = false;

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    const indexDir = join(this.bootstrap.homeDir, INDEX_DIR_NAME);
    this.backend = this.flags.enabled(SEARCH_WORKER_FLAG_ID)
      ? new SearchWorkerHost({ dir: indexDir, log: this.log })
      : new InlineSearchBackend({ indexDir, log: this.log });
    // Construction is on-demand (see the registration below): the server
    // pre-warms the service from start.ts, search requests resolve it per
    // call. Whenever it IS constructed, kick the first full sync off in the
    // background so the caller never blocks on indexing.
    this.requestSync();
  }

  setLiveTranscriptSource(source: LiveTranscriptSource): void {
    this.liveSource = source;
  }

  // -- lifecycle ---------------------------------------------------------------

  private get indexDir(): string {
    return join(this.bootstrap.homeDir, INDEX_DIR_NAME);
  }

  private toSyncInput(summary: SessionSummary): SyncSessionInput {
    return {
      id: summary.id,
      workspaceId: summary.workspaceId,
      title: summary.title,
      updatedAt: summary.updatedAt,
      dir: sessionDirOf(
        this.bootstrap.homeDir,
        workspacePersistenceScope(this.bootstrap.scope('sessions'), summary.workspaceId),
        summary.id,
      ),
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    // Synchronously gate the backend BEFORE any awaiting: an in-flight sync
    // pass skips its remaining writes at the next disposed check (the
    // review-#20 drain contract). Both hosts honor it: the inline core flips
    // its own flag; the worker host forwards a beginClose control message so
    // the worker-side core gates mid-pass too.
    this.backend.beginClose();
    // DI disposal is synchronous, but draining background work and closing
    // the backend are not: wait for the in-flight coordinator facades to
    // settle (bounded now — a gated pass returns early), then dispose the
    // backend (the inline core drains its tracked ops before closing the db;
    // the worker drains and closes on the `close` request, with terminate()
    // as the host's bounded backstop). The promise is
    // registered module-level so the server shutdown path
    // (`drainGlobalSearchDisposals` in start.ts) can await it before the
    // homeDir is torn down — otherwise teardown rm() races the close and
    // fails with ENOTEMPTY.
    const pending = (async () => {
      await this.syncPromise?.catch(() => {});
      await this.refreshPromise?.catch(() => {});
      await this.backend.dispose();
      this.drainSettled = true;
    })();
    pendingDisposals.add(pending);
    void pending.finally(() => pendingDisposals.delete(pending));
  }

  // -- sync coordinator (indexer only) -------------------------------------------
  //
  // Requests never await a sync; they ask the coordinator to schedule one.
  // Single-flight serializes passes, the debounce window coalesces bursts,
  // and backpressure is one queued follow-up behind the in-flight pass.

  private requestSync(): void {
    if (this.disposed || this.reindexing) return;
    if (this.syncPromise !== null) {
      // A pass is already running: queue exactly one follow-up.
      this.syncQueued = true;
      return;
    }
    const wait = this.syncDebounceMs - (Date.now() - this.lastSyncStartedAt);
    if (wait > 0) {
      // Inside the debounce window: coalesce requests into one trailing pass.
      if (this.syncTimer === null) {
        this.syncTimer = setTimeout(() => {
          this.syncTimer = null;
          this.requestSync();
        }, wait);
        this.syncTimer.unref?.();
      }
      return;
    }
    this.startSyncPass();
  }

  private startSyncPass(): void {
    this.syncQueued = false;
    void this.ensureSyncStarted().then(
      () => {
        this.lastRefreshError = null;
        if (this.syncQueued) {
          this.syncQueued = false;
          this.requestSync();
        }
      },
      (error: unknown) => {
        this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
        this.log.warn('global search: background sync failed', { error: errorMessage(error) });
      },
    );
  }

  /** Single-flight: concurrent callers share the in-flight sync. */
  private ensureSyncStarted(): Promise<void> {
    if (this.syncPromise === null) {
      const p = this.runSync().finally(() => {
        if (this.syncPromise === p) this.syncPromise = null;
      });
      this.syncPromise = p;
    }
    return this.syncPromise;
  }

  private async runSync(): Promise<void> {
    // `reindexing`: a rebuild is swapping the db out — this pass is a no-op;
    // the rebuild itself runs the authoritative sync when done.
    if (this.disposed || this.reindexing) return;
    const sessions = await this.listAllSessions();
    if (this.disposed) return; // dispose landed while sessions were enumerated
    // Nothing to index and no index on disk yet: don't even create the
    // `<home>/search-index` directory — it would show up in the fs folder
    // picker and cost every server boot a pointless db open.
    if (sessions.length === 0 && !(await pathExists(this.indexDir))) {
      this.summaries = new Map();
      this.lastSyncStartedAt = Date.now();
      return;
    }
    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    this.lastSyncStartedAt = Date.now();
    await this.backend.sync(sessions.map((s) => this.toSyncInput(s)));
  }

  private async listAllSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sessionIndex.listRecent({ before: cursor, limit: SESSION_PAGE_SIZE });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  /**
   * Drive a read-only refresh of the backend (single-flight facade).
   * Production note: request-path searches no longer call this — the core
   * kicks read-only refreshes internally and reports freshness via
   * `CoreIndexView.freshnessStale`. The facade remains as the deterministic
   * refresh drive for tests (`refreshNow`) and its promise feeds the
   * read-only-side `stale` bit while an explicit refresh is in flight. The
   * core records refresh failures itself (surfaced as `degraded`); only
   * worker-availability failures land in the rejection branch here — a
   * failed refresh must never fail the search that kicked it.
   */
  private refreshReadonly(): Promise<void> {
    if (this.refreshPromise === null) {
      this.refreshPromise = this.backend.refresh().then(
        () => {},
        (error: unknown) => {
          this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
          this.log.warn('global search: read-only refresh failed; serving the stale view', {
            error: errorMessage(error),
          });
        },
      );
      void this.refreshPromise.finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  // -- public API ---------------------------------------------------------------

  /**
   * Route: a container-scoped query on a session that is live in this process
   * scans the in-memory transcript store instead of the index, in both terms
   * and literal mode. Anything else takes the index route. The live route
   * never falls back on error — the store being in hand means the session is
   * alive, so a scan failure is a real error, not a degradation signal.
   */
  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const q = normalizeQuery(input, this.maxQueryTerms);
    const sessionId = q.container?.sessionId;
    const liveStore = sessionId !== undefined ? this.liveSource?.forSessionLive(sessionId) : undefined;
    if (liveStore !== undefined && sessionId !== undefined) {
      return this.searchLive(q, sessionId, liveStore, input.pageToken);
    }
    return this.searchIndex(q, input.pageToken);
  }

  // -- live route (in-memory transcript scan) ------------------------------------

  private async searchLive(
    q: NormalizedQuery,
    sessionId: string,
    store: TranscriptStore,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    // The live route has no published generations — the store mutates
    // continuously — so its keyset tokens carry no `g` and no generation
    // check applies; the (time, key) cursor itself is what keeps pages
    // consistent under concurrent appends.
    const page = decodePageToken(q, 'live', pageToken, undefined);
    const source = this.liveSource;
    if (source === null) {
      // Unreachable (the router only enters with a source-wired store), but a
      // null deref here would mask a wiring bug — fail loudly instead.
      throw new GlobalSearchError('index_unavailable', 'live transcript source is not wired');
    }
    // Backfill gates: the main-agent history, then every agent in scope, so
    // the scan covers full history rather than only post-resume content.
    await source.whenReady(sessionId);
    const agentIds =
      q.container?.agentId !== undefined
        ? [q.container.agentId]
        : store.agents().map((agent) => agent.agentId);
    for (const agentId of agentIds) {
      await source.ensureAgentHistory(sessionId, agentId);
    }
    const docs = await this.collectLiveDocs(sessionId, store, agentIds);
    const budget = {
      deadlineAt: Date.now() + this.queryDeadlineMs,
      textCharsLeft: this.queryTextBudgetChars,
    };
    const boundary = page.kind === 'keyset' ? page.boundary : undefined;
    // Literal mode needs no candidate index: every in-memory document is a
    // candidate and the shared confirmation pass decides. Terms mode runs the
    // in-memory AND match first, scoring each hit.
    const matched =
      q.mode === 'literal'
        ? matchDocs(
            q,
            docs.map(({ key, value }) => ({ key, value, score: 0 })),
            boundary,
            budget,
          )
        : matchDocs(q, matchLiveTerms(q.termsQuery ?? [], docs), boundary, budget);
    const { pageRows, hasMore } = paginateRows(q, page, matched.rows);
    return {
      items: pageRows.map((row) => this.projectHit(q, row)),
      hasMore,
      pageToken: hasMore
        ? encodePageToken(q, 'live', boundaryOf(q, pageRows[pageRows.length - 1]!), undefined)
        : undefined,
      incomplete: matched.incomplete,
      indexState: {
        state: 'ready',
        indexedSessions: 1,
        totalSessions: 1,
        documents: docs.length,
      },
      source: 'live',
    };
  }

  /**
   * Flatten the live transcript store into the same document shape the index
   * route searches (`MessageDoc` / `TitleDoc`), each with a stable synthetic
   * key for keyset pagination:
   *   - one user doc per non-empty `turn.prompt` (turn ordinal + turn time);
   *   - one assistant doc per assistant-role text frame (turn ordinal +
   *     stepId); thinking / tool / notice frames are skipped;
   *   - one title doc from the session-index summary, same as the sync path.
   * Text is trimmed and empty results skipped, mirroring the index side's
   * `wireExtract` (which trims both user and assistant text).
   */
  private async collectLiveDocs(
    sessionId: string,
    store: TranscriptStore,
    agentIds: readonly string[],
  ): Promise<{ key: string; value: MessageDoc | TitleDoc }[]> {
    const summary = await this.sessionIndex.get(sessionId);
    const workspaceId = summary?.workspaceId ?? '';
    const sessionTitle = summary?.title ?? '';
    const fallbackTime = summary?.updatedAt ?? 0;
    const parseTime = (iso: string | undefined): number => {
      if (iso === undefined) return fallbackTime;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? fallbackTime : ms;
    };
    const docs: { key: string; value: MessageDoc | TitleDoc }[] = [];
    for (const agentId of agentIds) {
      const transcript = store.getAgent(agentId);
      if (transcript === undefined) continue;
      for (const item of transcript.snapshot().items) {
        if (item.kind !== 'turn') continue;
        const turnTime = parseTime(item.startedAt);
        const prompt = item.prompt?.trim() ?? '';
        if (prompt.length > 0) {
          docs.push({
            key: `${sessionId}/${agentId}/live/u/t${item.ordinal}`,
            value: {
              kind: 'message',
              sessionId,
              workspaceId,
              sessionTitle,
              agentId,
              role: 'user',
              text: prompt.length > MAX_DOC_TEXT_CHARS ? prompt.slice(0, MAX_DOC_TEXT_CHARS) : prompt,
              time: turnTime,
              turn: item.ordinal,
              stepId: undefined,
            },
          });
        }
        for (const step of item.steps) {
          const stepTime = parseTime(step.endedAt ?? step.startedAt ?? item.startedAt);
          for (const frame of step.frames) {
            if (frame.kind !== 'text' || frame.role !== 'assistant') continue;
            const text = frame.text.trim();
            if (text.length === 0) continue;
            docs.push({
              key: `${sessionId}/${agentId}/live/a/${frame.frameId}`,
              value: {
                kind: 'message',
                sessionId,
                workspaceId,
                sessionTitle,
                agentId,
                role: 'assistant',
                text: text.length > MAX_DOC_TEXT_CHARS ? text.slice(0, MAX_DOC_TEXT_CHARS) : text,
                time: stepTime,
                turn: item.ordinal,
                stepId: step.stepId,
              },
            });
          }
        }
      }
    }
    if (sessionTitle.length > 0) {
      docs.push({
        key: `${sessionId}/$title`,
        value: {
          kind: 'title',
          sessionId,
          workspaceId,
          sessionTitle,
          agentId: '',
          role: 'title',
          text: sessionTitle,
          time: fallbackTime,
        },
      });
    }
    return docs;
  }

  // -- index route (backend: search worker, or the inline core) --------------------

  private budgets(): SearchBudgets {
    return {
      literalCandidateCap: this.literalCandidateCap,
      maxTextHits: this.maxTextHits,
      postingsVisitBudget: this.postingsVisitBudget,
      queryDeadlineMs: this.queryDeadlineMs,
      queryTextBudgetChars: this.queryTextBudgetChars,
    };
  }

  private async searchIndex(
    q: NormalizedQuery,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    // Query validation comes before any index-state handling: an invalid
    // query must fail the same way whether or not a generation is published.
    if (q.mode === 'literal') {
      // The n-gram index cannot confirm queries shorter than 2 normalized
      // code points. Judged AFTER normalization on purpose: NFKC can change
      // the length (the ligature 'ﬀ' folds to 'ff' and becomes legal). The
      // live route has no such constraint — it never reaches this branch.
      const literalLength = Array.from(q.literalQuery ?? '').length;
      if (literalLength < 2) {
        throw new GlobalSearchError(
          'invalid_query',
          'literal queries need at least 2 characters (after Unicode normalization)',
        );
      }
      if (literalLength > MAX_LITERAL_QUERY_CHARS) {
        throw new GlobalSearchError(
          'invalid_query',
          `literal queries are limited to ${MAX_LITERAL_QUERY_CHARS} characters`,
        );
      }
    }

    // The request path serves the currently published generation and never
    // waits for an open, sync, reopen or reindex: the backend answers from
    // its published base (or with building semantics) while the coordinator
    // below catches up in the background.
    let result: CoreSearchResult;
    try {
      result = await this.backend.search({ q, pageToken, budgets: this.budgets() });
    } catch (error) {
      if (error instanceof GlobalSearchError) {
        // A failed open self-heals through search traffic: kick a background
        // retry (runSync → backend.sync → ensureOpen), exactly like the
        // pre-worker service did.
        if (error.reason === 'index_unavailable') this.requestSync();
        throw error;
      }
      if (error instanceof SearchWorkerError) {
        // The worker is down (spawn failure, crash, backoff): never restore
        // the heavy work inline onto this thread — report a recognizable
        // degraded state. Recovery is LAZY: the respawn happens on the next
        // sync/search that arrives after the backoff window (kicked here),
        // never on a timer.
        this.lastRefreshError = { at: Date.now(), message: error.message };
        this.log.warn('global search: search worker unavailable; serving a degraded page', {
          error: error.message,
          code: error.code,
        });
        if (error.code === 'disposed') {
          // Same contract as the inline host after dispose: fail fast.
          throw new GlobalSearchError('index_unavailable', 'search service is disposed');
        }
        this.requestSync();
        if (pageToken !== undefined) {
          // No generation to validate the token against — the client
          // restarts the search once a base is published.
          throw new GlobalSearchError(
            'invalid_page_token',
            'the search index is not ready yet; restart the search',
          );
        }
        return this.buildingPage(null);
      }
      throw error;
    }

    // Writer-side kick (the read-only refresh kick happens inside the core):
    // the served generation is the one published by the last completed pass.
    if (!result.index.readOnly) this.requestSync();

    if (result.kind === 'building') return this.buildingPage(result.index);

    return {
      items: result.rows.map((row) => this.projectHit(q, row)),
      hasMore: result.hasMore,
      pageToken: result.hasMore
        ? encodePageToken(
            q,
            'index',
            boundaryOf(q, result.rows[result.rows.length - 1]!),
            result.generation,
          )
        : undefined,
      incomplete: result.incomplete,
      indexState: this.composeIndexState(result.index),
      source: 'index',
    };
  }

  // -- shared hit projection & index-state assembly -------------------------------

  private projectHit(q: NormalizedQuery, row: MatchedRow): GlobalSearchHit {
    const doc = row.value;
    return {
      sessionId: doc.sessionId,
      workspaceId: doc.workspaceId,
      sessionTitle: this.summaries.get(doc.sessionId)?.title ?? doc.sessionTitle,
      agentId: doc.agentId,
      role: doc.role,
      snippet:
        doc.kind === 'title'
          ? doc.text
          : row.anchor !== undefined && q.literalQuery !== undefined
            ? makeSnippet(doc.text, q.query, 80, { at: row.anchor, len: q.literalQuery.length })
            : makeSnippet(doc.text, q.query),
      time: doc.time,
      turn: doc.kind === 'message' ? doc.turn : undefined,
      stepId: doc.kind === 'message' ? doc.stepId : undefined,
      score: row.score,
    };
  }

  /**
   * Merge the backend's index view with the coordinator's writer-side state:
   * a page is stale when the backend knows its view is behind (read-only
   * freshness) OR a sync pass is in flight/queued/pending behind the
   * debounce window.
   */
  private composeIndexState(view: CoreIndexView): GlobalSearchIndexState {
    const coordinatorStale = view.readOnly
      ? this.refreshPromise !== null
      : this.syncPromise !== null || this.syncQueued || this.syncTimer !== null;
    return {
      state: view.state,
      indexedSessions: view.indexedSessions,
      totalSessions: view.readOnly
        ? view.indexedSessions
        : Math.max(view.indexedSessions, this.summaries.size),
      documents: view.documents,
      stale: view.freshnessStale || coordinatorStale || undefined,
      degraded: this.lastRefreshError?.message ?? view.degraded,
    };
  }

  /**
   * The page served while the index base is unavailable: the first full sync
   * has not finished yet (no db yet), a deferred open-time base build is
   * still running / finally failed on the served handle, or the search
   * worker is down. Same "never wait" rule as every other request path —
   * the background coordinator/build catches up and a later search serves
   * real hits.
   */
  private buildingPage(view: CoreIndexView | null): GlobalSearchPage {
    const indexed = view?.indexedSessions ?? 0;
    const readOnly = view?.readOnly === true;
    return {
      items: [],
      hasMore: false,
      pageToken: undefined,
      incomplete: undefined,
      indexState: {
        state: 'building',
        indexedSessions: indexed,
        totalSessions: readOnly ? indexed : Math.max(indexed, this.summaries.size),
        documents: view?.documents ?? 0,
        stale: true,
        degraded: this.lastRefreshError?.message ?? view?.degraded,
      },
      source: 'index',
    };
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    try {
      // Block new background passes BEFORE the first await, so no sync can
      // start writing into the db this rebuild is about to swap out.
      this.reindexing = true;
      await this.backend.ensureOpen();
      // Let the in-flight sync settle before the backend closes the db it
      // writes into. Syncs triggered while we wait see `reindexing` and
      // return as no-ops, so one await is sufficient — no new writer of the
      // old db can appear.
      await this.syncPromise?.catch(() => {});
      await this.backend.reindex();
      // The rebuild runs the authoritative sync itself — an explicit
      // maintenance operation, never ordinary in-request work.
      this.reindexing = false;
      await this.ensureSyncStarted();
      this.lastRefreshError = null;
    } catch (error) {
      this.reindexing = false;
      this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      throw error;
    }
    const stats = await this.backend.status();
    return { sessions: stats.sessions, documents: stats.documents };
  }

  async status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
    lifecycle: CoreLifecycleReport;
  }> {
    const empty = { sessions: 0, documents: 0, lastIndexedAt: null, generation: 0 };
    if (this.disposed) {
      return {
        ...empty,
        lifecycle: { state: this.drainSettled ? 'stopped' : 'closing' },
      };
    }
    try {
      const status = await this.backend.status();
      if (!status.readOnly) this.requestSync();
      return {
        sessions: status.sessions,
        documents: status.documents,
        lastIndexedAt: status.lastIndexedAt,
        generation: status.generation,
        degraded: this.lastRefreshError?.message ?? status.degraded,
        lifecycle: status.lifecycle,
      };
    } catch (error) {
      // A backend that cannot answer (failed open, worker down, wedged call
      // reaped by the watchdog) reports degraded — this diagnostic surface
      // never throws, exactly so the failure states stay observable.
      const message = errorMessage(error);
      return { ...empty, degraded: message, lifecycle: { state: 'degraded', detail: message } };
    }
  }

  /**
   * Synchronous LOCAL lifecycle report (stage 5): never kicks an open, never
   * spawns the worker, never awaits — the view that still answers DURING a
   * minutes-long first open (or while the worker backs off), where status()
   * would block. The up states (ready/building) come from the backend's
   * cached last response and may lag one RPC; status() is the exact,
   * round-trip variant. Reflected on the `/api/v1/debug` surface like every
   * Service method.
   */
  lifecycleReport(): CoreLifecycleReport {
    if (this.disposed) return { state: this.drainSettled ? 'stopped' : 'closing' };
    return this.backend.lifecycleSnapshot();
  }
}

// ---------------------------------------------------------------------------
// live-route terms matching
// ---------------------------------------------------------------------------

/**
 * Terms-mode matching for the live route. Both query (already tokenized and
 * deduplicated in `normalizeQuery`) and documents are split with minidb's
 * default `tokenize` — the same tokenizer the index route's 'body' text index
 * uses — so a document matches when EVERY query term appears in its term set
 * (AND). The score is Σ log(1 + tf) per query term: it is only comparable
 * within the live route, since there is no corpus-wide IDF in memory (the
 * `GlobalSearchSource` contract comment says the same). The shared
 * pagination applies the final (score, time, key) order over the returned
 * rows.
 */
function matchLiveTerms(
  terms: readonly string[],
  docs: readonly { key: string; value: MessageDoc | TitleDoc }[],
): { key: string; value: MessageDoc | TitleDoc; score: number }[] {
  // A query that tokenizes to nothing matches zero docs, same as the index.
  if (terms.length === 0) return [];
  const matched: { key: string; value: MessageDoc | TitleDoc; score: number }[] = [];
  for (const { key, value: doc } of docs) {
    const counts = new Map<string, number>();
    for (const token of tokenize(doc.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    let hit = true;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) {
        hit = false;
        break;
      }
      score += Math.log(1 + tf);
    }
    if (hit) matched.push({ key, value: doc, score });
  }
  return matched;
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  // OnDemand, not OnScopeCreated: kap-server's module graph is bundled into
  // the CLI (the `kimi web` subcommand), so its registrations land in the
  // global registry of every CLI process, and OnScopeCreated would make even
  // a plain TUI run spawn the sync worker and open the (potentially large)
  // search index at startup. The real server pre-warms the service
  // explicitly in start.ts (`setLiveTranscriptSource`), and the search route
  // resolves it per request.
  ScopeActivation.OnDemand,
  'globalSearch',
);
