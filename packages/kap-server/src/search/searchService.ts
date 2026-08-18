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

const INDEX_DIR_NAME = 'search-index';
const SESSION_PAGE_SIZE = 500;

const MAX_QUERY_TERMS = 32;
const MAX_LITERAL_QUERY_CHARS = 1_024;
const MAX_POSTINGS_VISITS = 250_000;
const QUERY_DEADLINE_MS = 500;
const QUERY_TEXT_BUDGET_CHARS = 16_000_000;
const MAX_TEXT_HITS = 100_000;
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

const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
}

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

function normalizeQuery(input: GlobalSearchQuery, maxQueryTerms: number): NormalizedQuery {
  const mode = input.mode ?? 'terms';
  const query = mode === 'literal' ? input.query : input.query.trim();
  if (query.length === 0) {
    throw new GlobalSearchError('invalid_query', 'query must be a non-empty string');
  }
  const literalQuery = mode === 'literal' ? normalizeLiteral(query) : undefined;
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
    this.requestSync();
  }

  setLiveTranscriptSource(source: LiveTranscriptSource): void {
    this.liveSource = source;
  }

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
    this.backend.beginClose();
    const pending = (async () => {
      await this.syncPromise?.catch(() => {});
      await this.refreshPromise?.catch(() => {});
      await this.backend.dispose();
      this.drainSettled = true;
    })();
    pendingDisposals.add(pending);
    void pending.finally(() => pendingDisposals.delete(pending));
  }

  private requestSync(): void {
    if (this.disposed || this.reindexing) return;
    if (this.syncPromise !== null) {
      this.syncQueued = true;
      return;
    }
    const wait = this.syncDebounceMs - (Date.now() - this.lastSyncStartedAt);
    if (wait > 0) {
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
    if (this.disposed || this.reindexing) return;
    const sessions = await this.listAllSessions();
    if (this.disposed) return;
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

  private async searchLive(
    q: NormalizedQuery,
    sessionId: string,
    store: TranscriptStore,
    pageToken: string | undefined,
  ): Promise<GlobalSearchPage> {
    const page = decodePageToken(q, 'live', pageToken, undefined);
    const source = this.liveSource;
    if (source === null) {
      throw new GlobalSearchError('index_unavailable', 'live transcript source is not wired');
    }
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
    if (q.mode === 'literal') {
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

    let result: CoreSearchResult;
    try {
      result = await this.backend.search({ q, pageToken, budgets: this.budgets() });
    } catch (error) {
      if (error instanceof GlobalSearchError) {
        if (error.reason === 'index_unavailable') this.requestSync();
        throw error;
      }
      if (error instanceof SearchWorkerError) {
        this.lastRefreshError = { at: Date.now(), message: error.message };
        this.log.warn('global search: search worker unavailable; serving a degraded page', {
          error: error.message,
          code: error.code,
        });
        if (error.code === 'disposed') {
          throw new GlobalSearchError('index_unavailable', 'search service is disposed');
        }
        this.requestSync();
        if (pageToken !== undefined) {
          throw new GlobalSearchError(
            'invalid_page_token',
            'the search index is not ready yet; restart the search',
          );
        }
        return this.buildingPage(null);
      }
      throw error;
    }

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
      this.reindexing = true;
      await this.backend.ensureOpen();
      await this.syncPromise?.catch(() => {});
      await this.backend.reindex();
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

function matchLiveTerms(
  terms: readonly string[],
  docs: readonly { key: string; value: MessageDoc | TitleDoc }[],
): { key: string; value: MessageDoc | TitleDoc; score: number }[] {
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
  ScopeActivation.OnDemand,
  'globalSearch',
);
