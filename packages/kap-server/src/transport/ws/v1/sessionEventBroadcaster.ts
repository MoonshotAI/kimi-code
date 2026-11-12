import type {
  ApprovalRequest,
  ApprovalResponse,
  Event2,
  IDisposable,
  Interaction,
  ISessionScopeHandle,
  QuestionResponse,
  QuestionResult,
  Scope,
  SessionActivityState,
  Workspace,
} from '@moonshot-ai/agent-core-v2';
import {
  Error2,
  ErrorCodes,
  IAgentLifecycleService,
  IEventService,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  ISessionActivityView,
  ISessionManager,
  followSessionLifecycles,
  getLiveSessionById,
  resumeSessionById,
  interactions,
  toDisposable,
} from '@moonshot-ai/agent-core-v2';
import type {
  ConfigWarningItem,
  ModelCatalogRefreshChange,
  ModelCatalogRefreshFailure,
  ModelCatalogRetiredDefault,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  Event,
} from './events';
import {
  configChangedEventSchema,
  modelCatalogChangedEventSchema,
} from '../../../protocol/events-zod';
import type { ConversationMessage } from '../../../protocol/conversation';
import type { InteractionEventMessage, InteractionOutcome } from '../../../protocol/interaction';
import {
  approvalExpiresAt,
  interactionAgentId,
  interactionOutcome,
} from '../../../protocol/interaction-wire';
import { toWireQuestion } from '../../../protocol/question-wire';
import type { AgentFeedMessage } from '../../../protocol/ws-agent';
import type { TowerActivityMessage, TowerStateMessage } from '../../../protocol/ws-control';
import type { TaskEventMessage, TaskListMessage } from '../../../protocol/ws-task';
import { toWireWorkspace } from '../../../routes/workspaces';
import type { ConversationEvent, ConversationFeed } from '../../../services/conversation/conversationFeed';
import type {
  ConversationFeedCreated,
  ConversationService,
} from '../../../services/conversation/conversationService';
import { mapError } from '../../errors';
import { ensureMainAgent } from '../../mainAgent';
import { SessionAgentFeed } from './sessionAgentFeed';
import { SessionTaskFeed } from './sessionTaskFeed';
import { toTaskMessage } from './taskState';

export interface EventEnvelope {
  readonly type: string;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface BroadcastLogger {
  warn(obj: unknown, msg: string): void;
  error?(obj: unknown, msg: string): void;
}

export type BroadcastDelivery = 'subscription' | 'immediate';

export type BroadcastFrame =
  | EventEnvelope
  | InteractionEventMessage
  | TaskEventMessage
  | TaskListMessage
  | AgentFeedMessage
  | TowerStateMessage
  | TowerActivityMessage
  | ConversationMessage;

export interface BroadcastTarget {
  send(frame: BroadcastFrame, delivery?: BroadcastDelivery): void;
}

interface SessionState {
  readonly sessionId: string;
  detached?: true;
  readonly targets: Map<BroadcastTarget, Map<string, AgentSubscription>>;
  readonly lifecycleDisposables: IDisposable[];
  readonly knownInteractions: Map<string, Interaction>;
  tasks?: SessionTaskFeed;
  agents?: SessionAgentFeed;
}

interface AgentSubscription {
  generation: number;
  conversation?: ConversationAttachment;
}

interface ConversationAttachment {
  readonly feed: ConversationFeed;
  readonly listener: IDisposable;
  pending?: ConversationEvent[];
}

interface WorkTracker {
  readonly subscription: IDisposable;
  deferred?: SessionActivityState;
}

const GLOBAL_SESSION_ID = '__global__';
const CONVERSATION_PAGE_TURNS = 10;

function disposeSessionState(state: SessionState): void {
  for (const d of state.lifecycleDisposables) d.dispose();
  state.lifecycleDisposables.length = 0;
  for (const agents of state.targets.values()) {
    for (const subscription of agents.values()) releaseConversation(subscription);
  }
}

function releaseConversation(subscription: AgentSubscription): void {
  subscription.generation += 1;
  subscription.conversation?.listener.dispose();
  subscription.conversation = undefined;
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  private readonly workTrackers = new Map<string, WorkTracker>();
  private readonly globalTargets = new Set<BroadcastTarget>();
  private globalQueue: Promise<void> = Promise.resolve();
  private readonly coreEventSubscription: IDisposable;
  private readonly deletionSubscription: IDisposable | undefined;
  private readonly createSubscription: IDisposable | undefined;
  private readonly lifecycleSubscription: IDisposable;
  private readonly feedSubscription: IDisposable;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly core: Scope;
      readonly logger?: BroadcastLogger;
      readonly conversations: ConversationService;
    },
  ) {
    const sessionManager = opts.core.accessor.get(ISessionManager);
    this.deletionSubscription = sessionManager.onWillDeleteSession?.((event) => {
      this.evictSession(event.sessionId);
    });
    this.lifecycleSubscription = followSessionLifecycles(opts.core.accessor, (service) => {
      const closeSubscription = service.onDidCloseSession((event) => {
        this.untrackWork(event.sessionId);
        this.detachSession(event.sessionId);
      });
      const archiveSubscription = service.onDidArchiveSession((event) => {
        this.untrackWork(event.sessionId);
        this.evictSession(event.sessionId);
      });
      return {
        dispose: () => {
          closeSubscription.dispose();
          archiveSubscription.dispose();
        },
      };
    });
    this.createSubscription = sessionManager.onDidCreateSession?.((event) => {
      this.trackWork(event.sessionId, event.handle);
      try {
        this.reattachSession(event.sessionId);
      } catch (error) {
        this.opts.logger?.warn({ sessionId: event.sessionId, err: error }, 'session event reattach failed');
      }
    });
    for (const session of sessionManager.list()) this.trackWork(session.id, session);
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
    this.feedSubscription = opts.conversations.onDidCreateFeed((created) => {
      this.onFeedCreated(created);
    });
  }

  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
  }

  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    agentIds: readonly string[],
    accepted?: () => void,
  ): Promise<void> {
    let session: ISessionScopeHandle | undefined;
    try {
      session = await resumeSessionById(this.opts.core.accessor, sessionId);
      if (session !== undefined) await ensureMainAgent(session);
    } catch (error) {
      this.opts.logger?.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'session subscribe failed',
      );
      throw error;
    }
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session not found: ${sessionId}`);
    }
    const state = this.ensureState(sessionId);
    if (state === undefined) {
      throw new Error(`session ${sessionId} closed while subscribing`);
    }
    let agents = state.targets.get(target);
    if (agents === undefined) {
      agents = new Map();
      state.targets.set(target, agents);
    }
    const added: string[] = [];
    for (const agentId of agentIds) {
      if (agents.has(agentId)) continue;
      agents.set(agentId, { generation: 0 });
      added.push(agentId);
    }
    accepted?.();
    this.sendAgentLists(state, target, added);
    for (const agentId of new Set(agentIds)) void this.sync(state, target, agentId);
  }

  unsubscribe(sessionId: string, target: BroadcastTarget, agentIds?: readonly string[]): void {
    const state = this.sessions.get(sessionId);
    const agents = state?.targets.get(target);
    if (state === undefined || agents === undefined) return;
    for (const agentId of agentIds ?? [...agents.keys()]) {
      const subscription = agents.get(agentId);
      if (subscription === undefined) continue;
      releaseConversation(subscription);
      agents.delete(agentId);
    }
    if (agents.size > 0) return;
    state.targets.delete(target);
    this.evictDetachedSession(sessionId);
  }

  sessionsOf(target: BroadcastTarget): string[] {
    return [...this.sessions.values()]
      .filter((state) => state.targets.has(target))
      .map((state) => state.sessionId)
      .toSorted();
  }

  removeTarget(target: BroadcastTarget): void {
    this.removeGlobalTarget(target);
    for (const sessionId of this.sessionsOf(target)) this.unsubscribe(sessionId, target);
  }

  private async sync(state: SessionState, target: BroadcastTarget, agentId: string): Promise<void> {
    const subscription = state.targets.get(target)?.get(agentId);
    if (subscription === undefined) return;
    const generation = ++subscription.generation;
    const current = (): boolean =>
      state.targets.get(target)?.get(agentId) === subscription && subscription.generation === generation;
    let feed: ConversationFeed;
    try {
      feed = await this.opts.conversations.feed(state.sessionId, agentId);
    } catch (error) {
      if (!current()) return;
      this.opts.logger?.warn(
        { sessionId: state.sessionId, agentId, err: error instanceof Error ? error.message : String(error) },
        'session subscribe conversation failed',
      );
      releaseConversation(subscription);
      const failure = mapError(error, '');
      try {
        target.send({
          type: 'turns.failed',
          session_id: state.sessionId,
          agent_id: agentId,
          event_created_at: new Date().toISOString(),
          code: failure.code,
          msg: failure.msg,
        });
      } catch {
      }
      return;
    }
    if (!current() || subscription.conversation?.feed === feed) return;
    subscription.conversation?.listener.dispose();
    const attachment: ConversationAttachment = {
      feed,
      listener: feed.subscribe((event) => {
        this.forwardConversation(state, target, agentId, attachment, event);
      }),
    };
    subscription.conversation = attachment;
    void this.sendPage(state, target, agentId, attachment);
  }

  private onFeedCreated({ sessionId, agentId }: ConversationFeedCreated): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    for (const [target, agents] of state.targets) {
      if (agents.has(agentId)) void this.sync(state, target, agentId);
    }
  }

  private forwardConversation(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    attachment: ConversationAttachment,
    event: ConversationEvent,
  ): void {
    if (state.targets.get(target)?.get(agentId)?.conversation !== attachment) return;
    if (attachment.pending !== undefined) attachment.pending.push(event);
    else this.sendConversation(target, state.sessionId, agentId, event);
  }

  private async sendPage(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    attachment: ConversationAttachment,
  ): Promise<void> {
    const pending: ConversationEvent[] = [];
    attachment.pending = pending;
    const page = await attachment.feed.page(undefined, CONVERSATION_PAGE_TURNS);
    if (state.targets.get(target)?.get(agentId)?.conversation !== attachment) return;
    attachment.pending = undefined;
    try {
      target.send({
        type: 'turns',
        session_id: state.sessionId,
        agent_id: agentId,
        event_created_at: new Date().toISOString(),
        ...page,
      });
    } catch {
    }
    for (const event of pending) this.sendConversation(target, state.sessionId, agentId, event);
  }

  private sendConversation(
    target: BroadcastTarget,
    sessionId: string,
    agentId: string,
    event: ConversationEvent,
  ): void {
    try {
      target.send({
        ...event,
        session_id: sessionId,
        agent_id: agentId,
        event_created_at: new Date().toISOString(),
      } as ConversationMessage);
    } catch {
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coreEventSubscription.dispose();
    this.deletionSubscription?.dispose();
    this.createSubscription?.dispose();
    this.lifecycleSubscription.dispose();
    this.feedSubscription.dispose();
    for (const sessionId of this.workTrackers.keys()) this.untrackWork(sessionId);
    for (const state of this.sessions.values()) disposeSessionState(state);
    this.sessions.clear();
    await this.globalQueue;
  }

  private evictSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.sessions.delete(sessionId);
    disposeSessionState(state);
    state.targets.clear();
  }

  private detachSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached === true) return;
    state.detached = true;
    disposeSessionState(state);
    state.knownInteractions.clear();
    this.evictDetachedSession(sessionId);
  }

  private evictDetachedSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached !== true || state.targets.size > 0) return;
    this.evictSession(sessionId);
  }

  private reattachSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached !== true) return;
    if (getLiveSessionById(this.opts.core.accessor, sessionId) === undefined) return;
    state.detached = undefined;
    this.attachInteractions(sessionId, state);
    this.attachAgentFeeds(sessionId, state);
    for (const [target, agents] of state.targets) {
      this.sendAgentLists(state, target, [...agents.keys()]);
      for (const agentId of agents.keys()) void this.sync(state, target, agentId);
    }
  }

  private ensureState(sessionId: string): SessionState | undefined {
    if (this.closed) return undefined;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.detached === true) this.reattachSession(sessionId);
      return existing.detached === true ? undefined : existing;
    }
    if (getLiveSessionById(this.opts.core.accessor, sessionId) === undefined) return undefined;
    const state: SessionState = {
      sessionId,
      targets: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
    };
    this.sessions.set(sessionId, state);
    this.attachInteractions(sessionId, state);
    this.attachAgentFeeds(sessionId, state);
    return state;
  }

  private attachAgentFeeds(sessionId: string, state: SessionState): void {
    const session = getLiveSessionById(this.opts.core.accessor, sessionId);
    if (session === undefined) return;
    const agents = session.accessor.get(IAgentLifecycleService);
    const tasks = new SessionTaskFeed(agents, (agentId, info) => {
      this.sendAgentFrame(state, agentId, toTaskMessage(state.sessionId, agentId, info));
    });
    const agentStates = new SessionAgentFeed(sessionId, agents, (agentId, message) => {
      this.sendAgentFrame(state, agentId, message);
    });
    state.tasks = tasks;
    state.agents = agentStates;
    state.lifecycleDisposables.push(tasks, agentStates);
  }

  private sendAgentLists(
    state: SessionState,
    target: BroadcastTarget,
    agentIds: readonly string[],
  ): void {
    const tasks = state.tasks;
    if (tasks === undefined) return;
    for (const agentId of agentIds) {
      const frames: BroadcastFrame[] = [
        {
          type: 'task.list',
          session_id: state.sessionId,
          agent_id: agentId,
          tasks: tasks.running(agentId),
        },
        ...(state.agents?.snapshot(agentId) ?? []),
      ];
      for (const frame of frames) {
        try {
          target.send(frame);
        } catch {
        }
      }
    }
  }

  private sendAgentFrame(
    state: SessionState,
    agentId: string,
    frame: TaskEventMessage | AgentFeedMessage,
  ): void {
    for (const [target, agents] of state.targets) {
      if (!agents.has(agentId)) continue;
      try {
        target.send(frame);
      } catch {
      }
    }
  }

  private trackWork(sessionId: string, session: ISessionScopeHandle): void {
    if (this.closed) return;
    this.untrackWork(sessionId);
    let workView: ISessionActivityView;
    try {
      workView = session.accessor.get(ISessionActivityView);
      workView.state();
    } catch (error) {
      this.opts.logger?.warn({ sessionId, err: error }, 'session work tracking failed');
      return;
    }
    const tracker: WorkTracker = {
      subscription: workView.onDidChange(({ state: work, cause }) => {
        if (cause === 'turn_ended') {
          tracker.deferred = work;
          queueMicrotask(() => {
            if (this.workTrackers.get(sessionId) !== tracker) return;
            this.flushDeferredWork(sessionId, tracker);
          });
          return;
        }
        this.flushDeferredWork(sessionId, tracker);
        this.enqueueWorkChanged(sessionId, work);
      }),
    };
    this.workTrackers.set(sessionId, tracker);
  }

  private untrackWork(sessionId: string): void {
    const tracker = this.workTrackers.get(sessionId);
    if (tracker === undefined) return;
    this.workTrackers.delete(sessionId);
    tracker.subscription.dispose();
  }

  private flushDeferredWork(sessionId: string, tracker: WorkTracker): void {
    const deferred = tracker.deferred;
    if (deferred === undefined) return;
    tracker.deferred = undefined;
    this.enqueueWorkChanged(sessionId, deferred);
  }

  private enqueueWorkChanged(sessionId: string, work: SessionActivityState): void {
    this.enqueueGlobal('event.session.work_changed', () => ({
      type: 'event.session.work_changed',
      busy: work.busy,
      main_turn_active: work.mainTurnActive,
      pending_interaction: work.pendingInteraction,
      last_turn_reason: work.lastTurnReason,
      agentId: 'main',
      sessionId,
    }));
  }

  private onCoreEvent(event: Event2<any>): void {
    const corePayload = (event as { readonly payload?: unknown }).payload;
    if (event.type === 'event.session.created') {
      const payload = sessionCreatedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.session.created',
        session: payload.session,
        agentId: 'main',
        sessionId: payload.sessionId,
      }));
      return;
    }
    if (event.type === 'event.session.archived' || event.type === 'event.session.restored') {
      const payload = sessionLifecyclePayload(corePayload);
      if (payload === undefined) return;
      const type = event.type;
      this.enqueueGlobal(
        type,
        () => ({
          type,
          workspace_id: payload.workspaceId,
          agentId: 'main',
          sessionId: payload.sessionId,
        }),
        GLOBAL_SESSION_ID,
      );
      return;
    }
    if (event.type === 'event.session.deleted') {
      const payload = sessionLifecyclePayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(
        event.type,
        () => ({
          type: 'event.session.deleted',
          workspace_id: payload.workspaceId,
          agentId: 'main',
          sessionId: payload.sessionId,
        }),
        GLOBAL_SESSION_ID,
      );
      return;
    }
    if (event.type === 'event.workspace.created' || event.type === 'event.workspace.updated') {
      const workspace = workspaceLifecyclePayload(corePayload);
      if (workspace === undefined) return;
      const type = event.type;
      this.enqueueGlobal(type, async () => ({
        type,
        workspace: await toWireWorkspace(this.opts.core, workspace),
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
    if (event.type === 'event.workspace.deleted') {
      const payload = workspaceDeletedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.workspace.deleted',
        workspace_id: payload.workspaceId,
        root: payload.root,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
    if (event.type === 'session.meta.updated') {
      const payload = sessionMetaUpdatedPayload(corePayload);
      if (payload === undefined) return;
      const sessionId = sessionMetaUpdatedSessionId(corePayload);
      if (sessionId === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'session.meta.updated',
        ...payload,
        agentId: 'main',
        sessionId,
      }));
      return;
    }
    if (event.type === 'event.plugin.changed') {
      this.enqueueGlobal(event.type, () => ({
        type: 'event.plugin.changed',
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
    if (event.type === 'event.capability.changed') {
      const payload = capabilityChangedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.capability.changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
    if (event.type === 'event.config.warning') {
      const payload = configWarningPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.config.warning',
        warnings: payload.warnings,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
    if (event.type === 'event.config.changed') {
      const payload = configChangedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.config.changed',
        changedFields: payload.changedFields,
        config: payload.config,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }) as Event);
      return;
    }
    if (event.type === 'event.model_catalog.changed') {
      const payload = modelCatalogChangedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.model_catalog.changed',
        changed: payload.changed,
        unchanged: payload.unchanged,
        failed: payload.failed,
        retired_default: payload.retired_default,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
      return;
    }
  }

  private enqueueGlobal(
    eventType: string,
    build: () => Event | Promise<Event>,
    envelopeSessionId?: string,
  ): void {
    if (this.closed) return;
    this.globalQueue = this.globalQueue
      .then(async () => {
        const event = await build();
        this.sendGlobal(event, envelopeSessionId ?? event.sessionId);
      })
      .catch((error: unknown) => this.logDispatchError(eventType, error));
  }

  private sendGlobal(event: Event, envelopeSessionId: string): void {
    const envelope: EventEnvelope = {
      type: event.type,
      session_id: envelopeSessionId,
      timestamp:
        event.time !== undefined ? new Date(event.time).toISOString() : new Date().toISOString(),
      payload: event,
    };
    for (const target of this.globalTargets) {
      try {
        target.send(envelope, 'immediate');
      } catch {
      }
    }
  }

  sendPendingInteractions(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached === true) return;
    for (const interaction of pendingInteractionsOf(sessionId)) {
      const message = interactionMessage(interaction, sessionId);
      if (message !== undefined) target.send(message, 'immediate');
    }
  }

  private attachInteractions(sessionId: string, state: SessionState): void {
    for (const i of pendingInteractionsOf(sessionId)) {
      state.knownInteractions.set(i.id, i);
    }
    state.lifecycleDisposables.push(
      toDisposable(
        interactions.onDidChangePending(() => {
          for (const i of pendingInteractionsOf(sessionId)) {
            if (state.knownInteractions.has(i.id)) continue;
            state.knownInteractions.set(i.id, i);
            this.sendInteraction(state, interactionMessage(i, sessionId));
          }
        }),
      ),
      toDisposable(
        interactions.onDidResolve(({ id, response }) => {
          const known = state.knownInteractions.get(id);
          if (known === undefined) return;
          state.knownInteractions.delete(id);
          this.sendInteraction(state, interactionMessage(known, sessionId, { response }));
        }),
      ),
    );
  }

  private sendInteraction(state: SessionState, message: InteractionEventMessage | undefined): void {
    if (message === undefined) return;
    for (const target of state.targets.keys()) {
      try {
        target.send(message);
      } catch {
      }
    }
  }

  private logDispatchError(eventType: string, error: unknown): void {
    const logger = this.opts.logger;
    if (logger === undefined) return;
    if (logger.error !== undefined) {
      logger.error({ eventType, err: error }, 'session event dispatch failed');
    } else {
      logger.warn({ eventType, err: error }, 'session event dispatch failed');
    }
  }
}

function pendingInteractionsOf(sessionId: string): readonly Interaction[] {
  return interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
  });
}

function interactionMessage(
  interaction: Interaction,
  sessionId: string,
  resolution?: { readonly response: unknown },
): InteractionEventMessage | undefined {
  const kind = interaction.kind;
  if (kind !== 'approval' && kind !== 'question') return undefined;
  const now = new Date().toISOString();
  const outcome =
    resolution === undefined ? undefined : interactionOutcome(kind, resolution.response);
  const common = {
    type: 'interaction' as const,
    session_id: sessionId,
    agent_id: interactionAgentId(interaction),
    event_created_at: now,
    interaction_id: interaction.id,
    status: outcome === undefined ? ('pending' as const) : ('ended' as const),
    outcome,
    ended_at: outcome === undefined ? undefined : now,
    tool_call_id: interactionToolCallId(interaction),
  };
  if (kind === 'approval') {
    const request = interaction.payload as ApprovalRequest;
    return {
      ...common,
      kind,
      request: {
        tool_name: request.toolName,
        action: request.action,
        tool_input_display: request.display,
        expires_at: approvalExpiresAt(interaction),
      },
      response:
        outcome === undefined ? undefined : approvalResponseOf(outcome, resolution?.response),
    };
  }
  return {
    ...common,
    kind,
    request: { questions: toWireQuestion(interaction, sessionId).questions },
    response: outcome === 'answered' ? questionResponseOf(resolution?.response) : undefined,
  };
}

function interactionToolCallId(interaction: Interaction): string | undefined {
  const tag = interaction.tags[INTERACTION_TAG_TOOL_CALL_ID];
  if (typeof tag === 'string') return tag;
  const fromPayload = (interaction.payload as { toolCallId?: unknown } | null | undefined)
    ?.toolCallId;
  return typeof fromPayload === 'string' ? fromPayload : undefined;
}

function approvalResponseOf(
  outcome: InteractionOutcome,
  response: unknown,
): Extract<InteractionEventMessage, { kind: 'approval' }>['response'] {
  const r = (response ?? {}) as Partial<ApprovalResponse>;
  return {
    decision: outcome === 'approved' || outcome === 'rejected' ? outcome : 'cancelled',
    scope: r.scope,
    feedback: r.feedback,
    selected_label: r.selectedLabel,
  };
}

function questionResponseOf(
  response: unknown,
): Extract<InteractionEventMessage, { kind: 'question' }>['response'] {
  const result = response as Exclude<QuestionResult, null>;
  if (isQuestionResponse(result)) return { answers: { ...result.answers }, method: result.method };
  return { answers: { ...result } };
}

function isQuestionResponse(result: Exclude<QuestionResult, null>): result is QuestionResponse {
  return typeof result.answers === 'object';
}

function sessionMetaUpdatedPayload(
  payload: unknown,
): Pick<SessionMetaUpdatedEvent, 'title' | 'patch'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<SessionMetaUpdatedEvent>;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const patch =
    typeof candidate.patch === 'object' &&
      candidate.patch !== null &&
      !Array.isArray(candidate.patch)
      ? candidate.patch
      : undefined;
  if (title === undefined && patch === undefined) return undefined;
  return { title, patch };
}

function sessionMetaUpdatedSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function sessionCreatedPayload(
  payload: unknown,
): { sessionId: string; session: SessionCreatedEvent['session'] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; session?: unknown };
  const sessionId =
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
      ? candidate.sessionId
      : undefined;
  const session =
    typeof candidate.session === 'object' &&
      candidate.session !== null &&
      !Array.isArray(candidate.session)
      ? (candidate.session as SessionCreatedEvent['session'])
      : undefined;
  if (sessionId === undefined || session === undefined) return undefined;
  return { sessionId, session };
}

function sessionLifecyclePayload(
  payload: unknown,
): { sessionId: string; workspaceId: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { sessionId?: unknown; workspaceId?: unknown };
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0) {
    return undefined;
  }
  if (typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length === 0) {
    return undefined;
  }
  return { sessionId: candidate.sessionId, workspaceId: candidate.workspaceId };
}

function workspaceLifecyclePayload(payload: unknown): Workspace | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = (payload as { workspace?: unknown }).workspace;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const ws = candidate as Partial<Workspace>;
  if (typeof ws.id !== 'string' || ws.id.length === 0) return undefined;
  if (typeof ws.root !== 'string' || ws.root.length === 0) return undefined;
  if (typeof ws.name !== 'string') return undefined;
  if (typeof ws.createdAt !== 'number' || typeof ws.lastOpenedAt !== 'number') return undefined;
  const additionalDirs = Array.isArray(ws.additionalDirs)
    ? ws.additionalDirs.filter((dir): dir is string => typeof dir === 'string')
    : [];
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    kind: ws.kind === 'managed' ? 'managed' : 'implicit',
    additionalDirs,
    createdAt: ws.createdAt,
    lastOpenedAt: ws.lastOpenedAt,
  };
}

function workspaceDeletedPayload(
  payload: unknown,
): { workspaceId: string; root: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as { workspaceId?: unknown; root?: unknown };
  if (typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length === 0) {
    return undefined;
  }
  if (typeof candidate.root !== 'string' || candidate.root.length === 0) return undefined;
  return { workspaceId: candidate.workspaceId, root: candidate.root };
}

interface CapabilityChangedPayload {
  capability_id: string;
  install: {
    running: boolean;
    step?: string;
    percent?: number;
    error?: string;
    note?: string;
    confirmationRequired?: 'stop-processes';
  };
}

function capabilityChangedPayload(payload: unknown): CapabilityChangedPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as { capability_id?: unknown }).capability_id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const install = (payload as { install?: unknown }).install;
  if (typeof install !== 'object' || install === null) return undefined;
  const running = (install as { running?: unknown }).running;
  if (typeof running !== 'boolean') return undefined;
  const out: CapabilityChangedPayload['install'] = { running };
  if ((install as { confirmationRequired?: unknown }).confirmationRequired === 'stop-processes') {
    out.confirmationRequired = 'stop-processes';
  }
  for (const key of ['step', 'error', 'note'] as const) {
    const value = (install as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = value;
  }
  const percent = (install as { percent?: unknown }).percent;
  if (typeof percent === 'number') out.percent = percent;
  return { capability_id: id, install: out };
}

function configWarningPayload(payload: unknown): { warnings: ConfigWarningItem[] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const warnings = (payload as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return undefined;
  const items: ConfigWarningItem[] = [];
  for (const warning of warnings) {
    if (typeof warning !== 'object' || warning === null) return undefined;
    const message = (warning as { message?: unknown }).message;
    if (typeof message !== 'string' || message.length === 0) return undefined;
    const domain = (warning as { domain?: unknown }).domain;
    if (domain !== undefined && typeof domain !== 'string') return undefined;
    items.push(typeof domain === 'string' ? { domain, message } : { message });
  }
  return { warnings: items };
}

const configChangedPayloadSchema = configChangedEventSchema.omit({ type: true });
const modelCatalogChangedPayloadSchema = modelCatalogChangedEventSchema.omit({ type: true });

function configChangedPayload(
  payload: unknown,
): { changedFields: string[]; config: unknown } | undefined {
  const parsed = configChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  return { changedFields: parsed.data.changedFields, config: parsed.data.config };
}

function modelCatalogChangedPayload(
  payload: unknown,
):
  | {
      changed: ModelCatalogRefreshChange[];
      unchanged: string[];
      failed: ModelCatalogRefreshFailure[];
      retired_default?: ModelCatalogRetiredDefault;
    }
  | undefined {
  const parsed = modelCatalogChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  return parsed.data;
}
