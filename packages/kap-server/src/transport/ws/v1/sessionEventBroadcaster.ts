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
  DiUnitChangedEvent,
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
import {
  filterOpsForGrade,
  gradeFor,
  needsResetOnTransition,
  redactSnapshotForGrade,
  type AgentTranscript,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptOperation,
  type TranscriptOpsEvent,
  type TranscriptResetEvent,
  type TranscriptStore,
} from '@moonshot-ai/transcript';

import type { InteractionEventMessage, InteractionOutcome } from '../../../protocol/interaction';
import {
  approvalExpiresAt,
  interactionAgentId,
  interactionOutcome,
} from '../../../protocol/interaction-wire';
import { toWireQuestion } from '../../../protocol/question-wire';
import { toWireWorkspace } from '../../../routes/workspaces';
import type { TranscriptService } from '../../../services/transcript/transcriptService';

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

export type BroadcastFrame = EventEnvelope | InteractionEventMessage;

export interface BroadcastTarget {
  send(frame: BroadcastFrame, delivery?: BroadcastDelivery): void;
}

interface TranscriptStream {
  readonly store: TranscriptStore;
  readonly knownAgents: Set<string>;
}

interface SessionState {
  readonly sessionId: string;
  detached?: true;
  readonly targets: Map<BroadcastTarget, TranscriptGradeSpec>;
  readonly lifecycleDisposables: IDisposable[];
  readonly knownInteractions: Map<string, Interaction>;
  transcriptStream?: TranscriptStream;
  readonly transcriptSeeded: Set<BroadcastTarget>;
}

interface WorkTracker {
  readonly subscription: IDisposable;
  deferred?: SessionActivityState;
}

const GLOBAL_SESSION_ID = '__global__';
const TRANSCRIPT_RESET_TAIL_TURNS = 0;

function disposeSessionState(state: SessionState): void {
  for (const d of state.lifecycleDisposables) d.dispose();
  state.lifecycleDisposables.length = 0;
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  private readonly workTrackers = new Map<string, WorkTracker>();
  private readonly globalTargets = new Set<BroadcastTarget>();
  private readonly diEventTargets = new Set<BroadcastTarget>();
  private globalQueue: Promise<void> = Promise.resolve();
  private readonly coreEventSubscription: IDisposable;
  private readonly deletionSubscription: IDisposable | undefined;
  private readonly createSubscription: IDisposable | undefined;
  private readonly lifecycleSubscription: IDisposable;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly core: Scope;
      readonly logger?: BroadcastLogger;
      readonly transcriptService?: TranscriptService;
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
      void this.reattachSession(event.sessionId).catch((error: unknown) =>
        this.opts.logger?.warn(
          { sessionId: event.sessionId, err: error },
          'session event reattach failed',
        ),
      );
    });
    for (const session of sessionManager.list()) this.trackWork(session.id, session);
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
  }

  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
    this.diEventTargets.delete(target);
  }

  addDiEventTarget(target: BroadcastTarget): void {
    this.diEventTargets.add(target);
  }

  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    transcriptGrades: TranscriptGradeSpec,
    transcriptSince?: Record<string, number>,
  ): Promise<boolean> {
    try {
      await resumeSessionById(this.opts.core.accessor, sessionId);
    } catch (error) {
      this.opts.logger?.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'session subscribe resume failed',
      );
      return false;
    }
    const state = await this.ensureState(sessionId);
    if (state === undefined || this.sessions.get(sessionId) !== state) return false;
    const prev = state.targets.get(target);
    state.targets.set(target, transcriptGrades);
    if (this.willSendTranscriptReset(state, transcriptGrades, prev)) {
      state.transcriptSeeded.delete(target);
    }
    await this.subscribeTranscript(state, target, transcriptGrades, prev, transcriptSince);
    if (state.targets.has(target)) state.transcriptSeeded.add(target);
    return true;
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.targets.delete(target);
    state.transcriptSeeded.delete(target);
    this.evictDetachedSession(sessionId);
  }

  updateTranscriptGrades(
    sessionId: string,
    target: BroadcastTarget,
    transcriptGrades: TranscriptGradeSpec,
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.targets.has(target)) return;
    state.targets.set(target, transcriptGrades);
  }

  private willSendTranscriptReset(
    state: SessionState,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    for (const descriptor of store.agents()) {
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === 'off') continue;
      if (needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade)) return true;
    }
    return false;
  }

  private async subscribeTranscript(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
    transcriptSince?: Record<string, number>,
  ): Promise<void> {
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return;
    await service.whenReady(state.sessionId);
    const backfill = new Set(
      Object.keys(spec).filter((agentId) => agentId !== '*' && gradeFor(spec, agentId) !== 'off'),
    );
    for (const descriptor of store.agents()) {
      if (gradeFor(spec, descriptor.agentId) !== 'off') backfill.add(descriptor.agentId);
    }
    await Promise.all(
      [...backfill].map((agentId) => service.ensureAgentHistory(state.sessionId, agentId)),
    );
    const currentSpec = state.targets.get(target);
    if (currentSpec === undefined) return;
    this.ensureTranscriptStream(state, store);
    for (const descriptor of store.agents()) {
      const grade = gradeFor(currentSpec, descriptor.agentId);
      if (grade === 'off') continue;
      const transcript = store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      const since = transcriptSince?.[descriptor.agentId] ?? transcriptSince?.['*'];
      if (since !== undefined) {
        const catchup = service.getOpsSince(state.sessionId, descriptor.agentId, since);
        if (catchup !== undefined && catchup.complete) {
          this.replayTranscriptOps(state, target, descriptor.agentId, grade, catchup.batches);
          continue;
        }
      }
      if (!needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade)) continue;
      this.sendTranscriptReset(state, target, transcript, grade);
    }
  }

  private replayTranscriptOps(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
    batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[],
  ): void {
    for (const batch of batches) {
      const filtered = filterOpsForGrade(grade, batch.ops);
      if (filtered.length === 0) continue;
      try {
        target.send(
          buildTranscriptEnvelope(state.sessionId, 'transcript.ops', {
            agent_id: agentId,
            ops: filtered,
            seq: batch.seq,
          }),
        );
      } catch {
      }
    }
  }

  private ensureTranscriptStream(state: SessionState, store: TranscriptStore): void {
    if (state.transcriptStream?.store === store) return;
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const stream: TranscriptStream = {
      store,
      knownAgents: new Set(store.agents().map((d) => d.agentId)),
    };
    state.transcriptStream = stream;

    const opsDisposable = service.onSessionOps(state.sessionId, ({ agentId, ops }, seq) => {
      for (const [target, spec] of state.targets) {
        if (!state.transcriptSeeded.has(target)) continue;
        const filtered = filterOpsForGrade(gradeFor(spec, agentId), ops);
        if (filtered.length === 0) continue;
        try {
          target.send(
            buildTranscriptEnvelope(state.sessionId, 'transcript.ops', {
              agent_id: agentId,
              ops: filtered,
              seq,
            }),
          );
        } catch {
        }
      }
    });
    if (opsDisposable !== undefined) state.lifecycleDisposables.push(opsDisposable);

    state.lifecycleDisposables.push(
      store.onRosterChange((agents) => {
        for (const descriptor of agents) {
          if (stream.knownAgents.has(descriptor.agentId)) continue;
          stream.knownAgents.add(descriptor.agentId);
          const transcript = store.getAgent(descriptor.agentId);
          if (transcript === undefined) continue;
          for (const [target, spec] of state.targets) {
            if (!state.transcriptSeeded.has(target)) continue;
            const grade = gradeFor(spec, descriptor.agentId);
            if (grade === 'off') continue;
            try {
              this.sendTranscriptReset(state, target, transcript, grade);
            } catch {
            }
          }
        }
      }),
    );
  }

  private sendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    transcript: AgentTranscript,
    grade: TranscriptGrade,
  ): void {
    const snapshot = redactSnapshotForGrade(
      grade,
      transcript.snapshot({ tailTurns: TRANSCRIPT_RESET_TAIL_TURNS }),
    );
    target.send(
      buildTranscriptEnvelope(state.sessionId, 'transcript.reset', {
        agent_id: transcript.agentId,
        snapshot,
        has_more_older: snapshot.hasMoreOlder ?? false,
        seq: this.opts.transcriptService?.getSeqWatermark(state.sessionId, transcript.agentId),
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coreEventSubscription.dispose();
    this.deletionSubscription?.dispose();
    this.createSubscription?.dispose();
    this.lifecycleSubscription.dispose();
    for (const sessionId of this.workTrackers.keys()) this.untrackWork(sessionId);
    for (const [sessionId, state] of this.sessions) {
      disposeSessionState(state);
      this.opts.transcriptService?.dropSession(sessionId);
    }
    this.sessions.clear();
    await this.globalQueue;
  }

  private evictSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state !== undefined) {
      this.sessions.delete(sessionId);
      state.targets.clear();
      disposeSessionState(state);
    }
    this.opts.transcriptService?.dropSession(sessionId);
  }

  private detachSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached === true) return;
    state.detached = true;
    disposeSessionState(state);
    state.knownInteractions.clear();
    state.transcriptSeeded.clear();
    state.transcriptStream = undefined;
    this.opts.transcriptService?.dropSession(sessionId);
    this.evictDetachedSession(sessionId);
  }

  private evictDetachedSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached !== true || state.targets.size > 0) return;
    this.evictSession(sessionId);
  }

  private async reattachSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.detached !== true) return;
    if (getLiveSessionById(this.opts.core.accessor, sessionId) === undefined) return;
    state.detached = undefined;
    this.attachInteractions(sessionId, state);
    for (const [target, spec] of state.targets) {
      await this.subscribeTranscript(state, target, spec, undefined);
      if (state.targets.has(target)) state.transcriptSeeded.add(target);
    }
  }

  private async ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return undefined;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      if (existing.detached !== true) return existing;
      await this.reattachSession(sessionId);
      return existing.detached === true ? undefined : existing;
    }
    if (getLiveSessionById(this.opts.core.accessor, sessionId) === undefined) return undefined;
    const state: SessionState = {
      sessionId,
      targets: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
    };
    this.sessions.set(sessionId, state);
    this.attachInteractions(sessionId, state);
    return state;
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
    if (event.type === 'event.session.archived') {
      const payload = sessionArchivedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(
        event.type,
        () => ({
          type: 'event.session.archived',
          workspace_id: payload.workspaceId,
          agentId: 'main',
          sessionId: payload.sessionId,
        }),
        GLOBAL_SESSION_ID,
      );
      return;
    }
    if (event.type === 'event.session.deleted') {
      const payload = sessionDeletedPayload(corePayload);
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
    if (event.type === 'event.di.unit_changed') {
      const payload = diUnitChangedPayload(corePayload);
      if (payload === undefined) return;
      this.enqueueGlobal(event.type, () => ({
        type: 'event.di.unit_changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      }));
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
    const diGated = event.type.startsWith('event.di.');
    for (const target of this.globalTargets) {
      if (diGated && !this.diEventTargets.has(target)) continue;
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

function buildTranscriptEnvelope(
  sessionId: string,
  type: 'transcript.reset' | 'transcript.ops',
  payload: Omit<TranscriptResetEvent, 'type'> | Omit<TranscriptOpsEvent, 'type'>,
): EventEnvelope {
  return {
    type,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { type, ...payload },
  };
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

const DI_UNIT_STATES: ReadonlySet<string> = new Set([
  'Pending',
  'Activating',
  'Active',
  'Unloading',
  'Failed',
]);

function diUnitChangedPayload(
  payload: unknown,
): Pick<DiUnitChangedEvent, 'scope' | 'token' | 'state' | 'error'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<DiUnitChangedEvent>;
  if (typeof candidate.scope !== 'string' || candidate.scope.length === 0) return undefined;
  if (typeof candidate.token !== 'string' || candidate.token.length === 0) return undefined;
  if (typeof candidate.state !== 'string' || !DI_UNIT_STATES.has(candidate.state)) {
    return undefined;
  }
  return {
    scope: candidate.scope,
    token: candidate.token,
    state: candidate.state as DiUnitChangedEvent['state'],
    error: typeof candidate.error === 'string' ? candidate.error : undefined,
  };
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

function sessionArchivedPayload(
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

function sessionDeletedPayload(
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
