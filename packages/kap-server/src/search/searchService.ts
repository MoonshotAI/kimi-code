import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import {
  createDecorator,
  databaseGlobalSearchEnabled,
  databaseSearchEnabled,
  databaseSearchSyncTuning,
  IBootstrapService,
  IConfigService,
  ILogService,
  ISessionIndex,
  LifecycleScope,
  ScopeActivation,
  registerScopedService,
  sessionDirOf,
  workspacePersistenceScope,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { normalizeLiteral, tokenize } from '@moonshot-ai/minidb';

import {
  GlobalSearchError,
  type GlobalSearchHit,
  type GlobalSearchIndexState,
  type GlobalSearchPage,
  type GlobalSearchQuery,
} from './contract';
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
  encodePageToken,
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
const GLOBAL_SEARCH_DISABLED_DETAIL =
  'global search is disabled; set [database] global_search = true or KIMI_CODE_GLOBAL_SEARCH=1 to enable it';

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

const pendingDisposals = new Set<Promise<void>>();

export async function drainGlobalSearchDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) {
    await Promise.all(pendingDisposals);
  }
}

export interface IGlobalSearchService {
  readonly _serviceBrand: undefined;
  search(query: GlobalSearchQuery): Promise<GlobalSearchPage>;
  reindex(): Promise<{ sessions: number; documents: number }>;
  status(): Promise<{
    sessions: number;
    documents: number;
    lastIndexedAt: number | null;
    generation: number;
    degraded?: string;
    lifecycle: CoreLifecycleReport;
  }>;
  lifecycleReport(): CoreLifecycleReport;
}

export const IGlobalSearchService = createDecorator<IGlobalSearchService>('globalSearch');

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

export interface SearchBackend {
  beginClose(): void;
  lifecycleSnapshot(): CoreLifecycleReport;
  ensureOpen(): Promise<unknown>;
  search(params: CoreSearchParams): Promise<CoreSearchResult>;
  sync(sessions: readonly SyncSessionInput[]): Promise<CoreSyncOutcome>;
  refresh(): Promise<unknown>;
  reindex(): Promise<unknown>;
  status(): Promise<CoreStatus>;
  dispose(): Promise<void>;
}

export class InlineSearchBackend implements SearchBackend {
  readonly core: SearchIndexCore;

  constructor(options: { indexDir: string; log: ILogService; syncSessionCap?: number }) {
    this.core = new SearchIndexCore({
      ...options,
      bootSalt: randomUUID(),
      onLockToken: noteLiveLockToken,
    });
    if (options.syncSessionCap !== undefined) this.core.syncSessionCap = options.syncSessionCap;
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

  syncDebounceMs = 2_000;

  literalCandidateCap = LITERAL_CANDIDATE_CAP;

  maxTextHits = MAX_TEXT_HITS;

  postingsVisitBudget = MAX_POSTINGS_VISITS;

  queryDeadlineMs = QUERY_DEADLINE_MS;

  queryTextBudgetChars = QUERY_TEXT_BUDGET_CHARS;

  maxQueryTerms = MAX_QUERY_TERMS;

  private backend: SearchBackend | null = null;
  private backendPromise: Promise<SearchBackend> | null = null;
  private syncPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private lastSyncStartedAt = 0;
  private summaries = new Map<string, SessionSummary>();
  private disposed = false;
  private reindexing = false;
  private syncQueued = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefreshError: { at: number; message: string } | null = null;
  private drainSettled = false;
  private disabledLogged = false;

  constructor(
    @ISessionIndex private readonly sessionIndex: ISessionIndex,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IConfigService private readonly config: IConfigService,
  ) {
    this.requestSync();
  }

  private get indexDir(): string {
    return join(this.bootstrap.homeDir, INDEX_DIR_NAME);
  }

  private ensureBackend(): Promise<SearchBackend> {
    if (this.backend !== null) return Promise.resolve(this.backend);
    this.backendPromise ??= this.config.ready.then(() => {
      if (!databaseGlobalSearchEnabled(this.config)) {
        throw new GlobalSearchError('index_unavailable', GLOBAL_SEARCH_DISABLED_DETAIL);
      }
      if (this.backend === null) {
        const tuning = databaseSearchSyncTuning(this.config);
        if (tuning.debounceMs !== undefined) this.syncDebounceMs = tuning.debounceMs;
        this.backend = databaseSearchEnabled(this.config)
          ? new SearchWorkerHost({ dir: this.indexDir, log: this.log, syncSessionCap: tuning.sessionCap })
          : new InlineSearchBackend({
              indexDir: this.indexDir,
              log: this.log,
              syncSessionCap: tuning.sessionCap,
            });
        if (this.disposed) this.backend.beginClose();
      }
      return this.backend;
    });
    return this.backendPromise;
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
    this.backend?.beginClose();
    const pending = (async () => {
      await this.syncPromise?.catch(() => {});
      await this.refreshPromise?.catch(() => {});
      const backend = await this.backendPromise?.catch(() => undefined);
      await backend?.dispose();
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
    if (!(await this.enabled())) return;
    const backend = await this.ensureBackend();
    const sessions = await this.listAllSessions();
    if (this.disposed) return;
    if (sessions.length === 0 && !(await pathExists(this.indexDir))) {
      this.summaries = new Map();
      this.lastSyncStartedAt = Date.now();
      return;
    }
    this.summaries = new Map(sessions.map((s) => [s.id, s]));
    this.lastSyncStartedAt = Date.now();
    const outcome = await backend.sync(sessions.map((s) => this.toSyncInput(s)));
    if (outcome.truncated || outcome.failures > 0) this.requestSync();
  }

  private async enabled(): Promise<boolean> {
    await this.config.ready;
    if (databaseGlobalSearchEnabled(this.config)) return true;
    if (!this.disabledLogged) {
      this.disabledLogged = true;
      this.log.info(`global search: ${GLOBAL_SEARCH_DISABLED_DETAIL}`);
    }
    return false;
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

  private refreshReadonly(): Promise<void> {
    if (this.refreshPromise === null) {
      this.refreshPromise = this.ensureBackend()
        .then((backend) => backend.refresh())
        .then(
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

  async search(input: GlobalSearchQuery): Promise<GlobalSearchPage> {
    const q = normalizeQuery(input, this.maxQueryTerms);
    if (!(await this.enabled())) {
      throw new GlobalSearchError('index_unavailable', GLOBAL_SEARCH_DISABLED_DETAIL);
    }
    return this.searchIndex(q, input.pageToken);
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
      const backend = await this.ensureBackend();
      result = await backend.search({ q, pageToken, budgets: this.budgets() });
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
            boundaryOf(q, result.rows.at(-1)!),
            result.generation,
          )
        : undefined,
      incomplete: result.incomplete,
      indexState: this.composeIndexState(result.index),
    };
  }

  private projectHit(q: NormalizedQuery, row: MatchedRow): GlobalSearchHit {
    const doc = row.value;
    return {
      sessionId: doc.sessionId,
      workspaceId: doc.workspaceId,
      sessionTitle: doc.sessionTitle,
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
    };
  }

  async reindex(): Promise<{ sessions: number; documents: number }> {
    const backend = await this.ensureBackend();
    try {
      this.reindexing = true;
      await backend.ensureOpen();
      await this.syncPromise?.catch(() => {});
      await backend.reindex();
      this.reindexing = false;
      await this.ensureSyncStarted();
      this.lastRefreshError = null;
    } catch (error) {
      this.reindexing = false;
      this.lastRefreshError = { at: Date.now(), message: errorMessage(error) };
      throw error;
    }
    const stats = await backend.status();
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
    if (!(await this.enabled())) {
      return { ...empty, lifecycle: { state: 'stopped', detail: GLOBAL_SEARCH_DISABLED_DETAIL } };
    }
    try {
      const backend = await this.ensureBackend();
      const status = await backend.status();
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

  lifecycleReport(): CoreLifecycleReport {
    if (this.disposed) return { state: this.drainSettled ? 'stopped' : 'closing' };
    return this.backend?.lifecycleSnapshot() ?? { state: 'stopped' };
  }
}

registerScopedService(
  LifecycleScope.App,
  IGlobalSearchService,
  GlobalSearchService,
  ScopeActivation.OnDemand,
  'globalSearch',
);
