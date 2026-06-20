import { Disposable, IInstantiationService, InstantiationType, registerSingleton } from '../../di';
import { Emitter } from '../../base/common/event';
import { ErrorCodes, KimiError } from '../../errors';
import type { AgentContextData, ContextMessage } from '../../agent/context';
import type { JsonObject, SessionSummary } from '../../rpc';
import {
  type CompactSessionRequest,
  type CompactSessionResponse,
  type Message,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatus,
  type SessionStatusResponse,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

import { IApprovalService } from '../approval/approval';
import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { toProtocolMessage } from '../message/message';
import { IPromptService, type AgentStatePatch } from '../prompt/prompt';
import { IQuestionService } from '../question/question';
import {
  ISessionQueryService,
  ISessionRuntimeService,
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
  type SessionCreateOptions,
  type SessionListQuery,
} from './session';
import { SessionQueryService } from './sessionQueryService';
import { SessionRuntimeService } from './sessionRuntimeService';
import { applySessionTurnEvent, computeSessionStatus, tryGetSessionMeta } from './sessionStatus';

const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;
const CHILD_SESSION_KIND = 'child';

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function canUndoHistory(history: readonly ContextMessage[], count: number): boolean {
  let found = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') return false;
    if (isRealUserPrompt(message)) {
      found++;
      if (found >= count) return true;
    }
  }
  return false;
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return origin.kind === 'skill_activation' && origin.trigger === 'user-slash';
}

function pageContextMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  context: AgentContextData,
  requestedPageSize: number | undefined,
): PageResponse<Message> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = context.history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  private readonly _activeTurns = new Set<string>();
  private readonly _abortedTurns = new Set<string>();
  private _promptService: IPromptService | undefined;
  private readonly _sessionQueryService: ISessionQueryService;
  private readonly _sessionRuntimeService: ISessionRuntimeService;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IApprovalService private readonly approvalService: IApprovalService,
    @IQuestionService private readonly questionService: IQuestionService,
  ) {
    super();
    // Keep our own turn-tracking sets so `_patchSessionStatus` can stamp the
    // live status onto sessions returned by create/get/update/fork/createChild.
    // The `event.session.status_changed` emission now lives on the composed
    // SessionRuntimeService (below); this subscription only feeds the local
    // sets, mirroring how SessionQueryService keeps its own sets in M1.3.
    this._register(
      this.eventService.onDidPublish((event) => {
        applySessionTurnEvent(
          { activeTurns: this._activeTurns, abortedTurns: this._abortedTurns },
          event,
        );
      }),
    );
    // Compose the query facade from our own deps so list / listChildren can
    // delegate to it. Constructed eagerly (rather than resolved lazily through
    // IInstantiationService) so it subscribes to the event bus from the start
    // and its live status stays in lock-step with SessionService; this also
    // keeps direct `new SessionService(...)` callers (e.g. unit tests) working
    // without an ISessionQueryService stub in the DI container.
    this._sessionQueryService = this._register(
      new SessionQueryService(
        this.core,
        this.eventService,
        this.instantiation,
        this.approvalService,
        this.questionService,
      ),
    );
    // Compose the runtime facade for the same reasons: eager construction
    // makes it subscribe to the bus from the start (so its status_changed
    // emission and `getStatus` delegation stay in lock-step), and keeps
    // positional `new SessionService(...)` construction working.
    this._sessionRuntimeService = this._register(
      new SessionRuntimeService(
        this.core,
        this.eventService,
        this.instantiation,
        this.approvalService,
        this.questionService,
      ),
    );
  }

  private get promptService(): IPromptService {
    return (this._promptService ??= this.instantiation.invokeFunction((a) => a.get(IPromptService)));
  }

  /**
   * Compute the session lifecycle status from live daemon state.
   *
   * Priority:
   *   1. awaiting_approval — pending approvals exist
   *   2. awaiting_question — pending questions exist
   *   3. running           — active prompt or active turn
   *   4. aborted           — last turn ended as cancelled/failed and no new work started
   *   5. idle              — everything else
   */
  private _computeStatus(sessionId: string): SessionStatus {
    return computeSessionStatus({
      awaitingApproval: this.approvalService.listPending(sessionId).length > 0,
      awaitingQuestion: this.questionService.listPending(sessionId).length > 0,
      hasActivePrompt: this.promptService.getCurrentPromptId(sessionId) !== undefined,
      hasActiveTurn: this._activeTurns.has(sessionId),
      wasAborted: this._abortedTurns.has(sessionId),
    });
  }

  /**
   * Overwrite the placeholder status on a protocol Session with the live value
   * computed from our own turn-tracking sets and the pending approval /
   * question / prompt services.
   */
  private _patchSessionStatus(session: Session): Session {
    session.status = this._computeStatus(session.id);
    return session;
  }

  async create(input: SessionCreate, options?: SessionCreateOptions): Promise<Session> {
    if (input.metadata === undefined || typeof input.metadata.cwd !== 'string') {
      throw new Error('SessionService.create: metadata.cwd is required');
    }
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      model: input.agent_config?.model,
      client: options?.client,
    });
    if (input.title !== undefined) {
      try {
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
      }
    }
    const meta = await tryGetSessionMeta(this.core, summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    return this._sessionQueryService.list(query);
  }

  async get(id: string): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await tryGetSessionMeta(this.core, id);
    return this._patchSessionStatus(toProtocolSession(summary, meta));
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    const ac = input.agent_config;
    if (ac !== undefined) {
      const patch: AgentStatePatch = {};
      if (ac.model !== undefined && ac.model !== '') patch.model = ac.model;
      if (ac.thinking !== undefined) patch.thinking = ac.thinking;
      if (ac.permission_mode !== undefined) patch.permission_mode = ac.permission_mode;
      if (ac.plan_mode !== undefined) patch.plan_mode = ac.plan_mode;
      if (ac.swarm_mode !== undefined) patch.swarm_mode = ac.swarm_mode;
      if (ac.goal_objective !== undefined) patch.goal_objective = ac.goal_objective;
      if (ac.goal_control !== undefined) patch.goal_control = ac.goal_control;
      if (
        patch.model !== undefined ||
        patch.thinking !== undefined ||
        patch.permission_mode !== undefined ||
        patch.plan_mode !== undefined ||
        patch.swarm_mode !== undefined ||
        patch.goal_objective !== undefined ||
        patch.goal_control !== undefined
      ) {
        await this.promptService.applyAgentState(id, patch, 'meta');
      }
    }

    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await tryGetSessionMeta(this.core, id);
    return this._patchSessionStatus(toProtocolSession(summaryAfter, meta));
  }

  async fork(id: string, input: SessionFork): Promise<Session> {
    const source = await this.get(id);
    const title = input.title ?? `Fork: ${source.title || source.id}`;
    const metadata = input.metadata === undefined ? undefined : asJsonObject(input.metadata);
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await tryGetSessionMeta(this.core, summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    return this._sessionQueryService.listChildren(id, query);
  }

  async createChild(id: string, input: SessionChildCreate): Promise<Session> {
    const parent = await this.get(id);
    const title = input.title ?? `Child: ${parent.title || parent.id}`;
    const metadata = asJsonObject({
      ...input.metadata,
      parent_session_id: id,
      child_session_kind: CHILD_SESSION_KIND,
    });
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await tryGetSessionMeta(this.core, summary.id);
    const session = this._patchSessionStatus(toProtocolSession(summary, meta));
    this.emitCreated(session);
    return session;
  }

  private emitCreated(session: Session): void {
    this._onDidCreate.fire({ session });
    this.eventService.publish({
      type: 'event.session.created',
      agentId: 'main',
      sessionId: session.id,
      session,
    });
  }

  async getStatus(id: string): Promise<SessionStatusResponse> {
    return this._sessionRuntimeService.getStatus(id);
  }

  async compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    // beginCompaction only sees sessions loaded in core memory — resume first
    // (mirrors undo) so compacting a freshly-opened session doesn't throw
    // SESSION_NOT_FOUND.
    await this.core.rpc.resumeSession({ sessionId: id });

    const instruction = normalizeOptionalString(input.instruction);
    await this.core.rpc.beginCompaction({
      sessionId: id,
      agentId: 'main',
      instruction,
    });
    return {};
  }

  async undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse> {
    const summary = await this.requireSummary(id);
    await this.core.rpc.resumeSession({ sessionId: id });
    const before = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    if (!canUndoHistory(before.history, input.count)) {
      throw new SessionUndoUnavailableError(id);
    }

    try {
      await this.core.rpc.undoHistory({
        sessionId: id,
        agentId: 'main',
        count: input.count,
      });
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new SessionUndoUnavailableError(id, error.message);
      }
      throw error;
    }

    const after = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    return {
      messages: pageContextMessages(id, summary.createdAt, after, input.page_size),
      status: await this.getStatus(id),
    };
  }

  async archive(id: string): Promise<{ archived: true }> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.archiveSession({ sessionId: id });
    this._onDidClose.fire({ sessionId: id });
    this._activeTurns.delete(id);
    this._abortedTurns.delete(id);
    return { archived: true };
  }

  private async requireSummary(id: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    return summary;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

registerSingleton(ISessionService, SessionService, InstantiationType.Delayed);
