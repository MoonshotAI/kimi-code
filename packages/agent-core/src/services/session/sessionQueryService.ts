import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../_base/di';
import type { PageResponse, Session } from '@moonshot-ai/protocol';
import type { CoreRPC, SessionSummary } from '../../rpc';

import { IApprovalService } from '#/approval';
import { ICoreRuntime } from '#/coreProcess';
import { IEventService } from '#/event';
import { IPromptService } from '../prompt/prompt';
import { IQuestionService } from '#/question';
import {
  ISessionQueryService,
  SessionNotFoundError,
  toProtocolSession,
  type SessionIndexArchiveVisibility,
  type SessionListQuery,
  type SessionQueryScope,
  type SessionSearchQuery,
} from './session';
import { SessionIndex } from './sessionIndex';
import {
  applySessionTurnEvent,
  computeSessionStatus,
  tryGetSessionMeta,
} from './sessionStatus';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

/**
 * Reproduces the `compareSessionSummary` ordering used by
 * `core.rpc.listSessions` (updatedAt desc → createdAt desc → id asc).
 *
 * Today's `SessionService.list` returns rows in this order (the RPC already
 * sorts this way and the service's stable `toSorted` by `updatedAt` preserves
 * it), so the query service re-sorts with the same comparator to stay
 * byte-for-byte identical at the protocol level instead of relying on the
 * index's simpler updatedAt/id tie-break.
 */
function compareSessionSummaries(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Read-model facade for sessions (query role).
 *
 * Serves list / count / search from the `SessionIndex` read model. Each call
 * re-seeds a fresh index from the in-process `listSessions` accessor
 * (`{ includeArchive: true }`) so freshness matches today's
 * `SessionService.list` (which reads the store on every call); M1.5 will
 * replace this with a persistent index kept in sync by the command path.
 *
 * The query path is cold: it only reads `listSessions` + per-row
 * `getSessionMetadata` and never calls `resumeSession` / `getReadyAgent`, so a
 * plain list cannot resume an agent. Live status is derived via the shared
 * `computeSessionStatus` helper fed by this service's own turn-tracking sets
 * (driven by the same event-bus events `SessionService` consumes), keeping the
 * read path's status byte-identical without reaching into `SessionService`.
 */
export class SessionQueryService extends Disposable implements ISessionQueryService {
  readonly _serviceBrand: undefined;

  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();
  private _promptService: IPromptService | undefined;

  constructor(
    @ICoreRuntime private readonly core: ICoreRuntime,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
  ) {
    super();
    this._register(
      this.eventService.onDidPublish((event) => {
        applySessionTurnEvent(
          { activeTurns: this._activeTurns, abortedTurns: this._abortedTurns },
          event,
        );
      }),
    );
  }

  private get promptService(): IPromptService {
    return (this._promptService ??= this.instantiation.invokeFunction((a) => a.get(IPromptService)));
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site below reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
  }

  private computeStatus(sessionId: string) {
    return computeSessionStatus({
      awaitingApproval: this.approvalService.listPending(sessionId).length > 0,
      awaitingQuestion: this.questionService.listPending(sessionId).length > 0,
      hasActivePrompt: this.promptService.getCurrentPromptId(sessionId) !== undefined,
      hasActiveTurn: this._activeTurns.has(sessionId),
      wasAborted: this._abortedTurns.has(sessionId),
    });
  }

  private patchStatus(session: Session): Session {
    session.status = this.computeStatus(session.id);
    return session;
  }

  /**
   * Build a fresh index from the store. `includeArchive: true` loads the full
   * global set so the index can apply archive visibility per scope; each call
   * re-reads to match today's per-call freshness.
   */
  private async loadIndex(): Promise<SessionIndex> {
    const index = new SessionIndex();
    const summaries = await this.coreApi().listSessions({ includeArchive: true });
    for (const summary of summaries) {
      index.upsert(summary);
    }
    return index;
  }

  /**
   * Pagination + hydration shared by every list surface. Mirrors today's
   * `SessionService.list` exactly: cursor pivot on the sorted set, page-size
   * clamp, `has_more` measured before the post-hydration status filter.
   */
  private async paginate(
    summaries: readonly SessionSummary[],
    query: SessionListQuery,
  ): Promise<PageResponse<Session>> {
    const sorted = summaries.toSorted(compareSessionSummaries);

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: readonly SessionSummary[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    const items = await Promise.all(
      pageSummaries.map(async (s) =>
        this.patchStatus(toProtocolSession(s, await tryGetSessionMeta(this.core, s.id))),
      ),
    );

    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const index = await this.loadIndex();
    const scope: SessionQueryScope =
      query.workDir !== undefined ? { kind: 'workDir', workDir: query.workDir } : { kind: 'global' };
    const archived: SessionIndexArchiveVisibility = query.includeArchive ? 'include' : 'exclude';
    return this.paginate(index.list(scope, { archived }), query);
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    const index = await this.loadIndex();
    const parent = index.get(id);
    // Mirror today's `SessionService.listChildren`, which first runs `get(id)`
    // (global, archived excluded) and throws for a missing or archived parent.
    if (parent === undefined || parent.archived === true) {
      throw new SessionNotFoundError(id);
    }
    // Today's implementation always excludes archived children and ignores
    // `workDir` / `includeArchive` on the query.
    const scope: SessionQueryScope = { kind: 'children', parentId: id };
    return this.paginate(index.list(scope, { archived: 'exclude' }), query);
  }

  async listGlobal(query: SessionListQuery): Promise<PageResponse<Session>> {
    const index = await this.loadIndex();
    const archived: SessionIndexArchiveVisibility = query.includeArchive ? 'include' : 'exclude';
    return this.paginate(index.list({ kind: 'global' }, { archived }), query);
  }

  async listByWorkspace(
    workspaceId: string,
    query: SessionListQuery,
  ): Promise<PageResponse<Session>> {
    const index = await this.loadIndex();
    const archived: SessionIndexArchiveVisibility = query.includeArchive ? 'include' : 'exclude';
    const scope: SessionQueryScope = { kind: 'workspace', workspaceId };
    return this.paginate(index.list(scope, { archived }), query);
  }

  async count(scope?: SessionQueryScope): Promise<number> {
    const index = await this.loadIndex();
    return index.count(scope ?? { kind: 'global' });
  }

  async search(query: SessionSearchQuery): Promise<PageResponse<Session>> {
    const index = await this.loadIndex();
    const scope: SessionQueryScope =
      query.workDir !== undefined ? { kind: 'workDir', workDir: query.workDir } : { kind: 'global' };
    const archived: SessionIndexArchiveVisibility = query.includeArchive ? 'include' : 'exclude';
    return this.paginate(index.search(scope, query.q, { archived }), query);
  }
}

registerSingleton(ISessionQueryService, SessionQueryService, InstantiationType.Delayed);
