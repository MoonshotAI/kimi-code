/**
 * `SessionEventBroadcaster` — per-session single fan-out point that turns agent
 * events (via the per-agent `IEventBus`) into a sequenced,
 * journaled, replayable `/api/v1/ws` event stream (the `{seq, epoch}` watermark).
 *
 * Port of v1's `WSBroadcastService` (`packages/server/.../wsBroadcastService.ts`),
 * adapted to v2 where agent events live on the per-agent `IEventBus`
 * (not a Core firehose). For each session it:
 *
 *   1. Subscribes to every agent's `IEventBus` via
 *      `IAgentLifecycleService` reach-down-via-handle (and `onDidCreate` /
 *      `onDidDispose` for late agents); `record` emissions are persisted and not
 *      broadcast (see step 3). Also subscribes to the session's
 *      `ISessionInteractionService` and synthesizes the v1 approval/question
 *      protocol events from pending-set changes and resolutions.
 *   2. Attaches `agentId`/`sessionId` to build the wire `Event`.
 *   3. Classifies durable vs volatile — `isVolatileSignal` for the agent
 *      wire-emission path (`isVolatileEventType` remains for the global/model path).
 *   4. Durable events: assign the next per-session `seq` (monotonic across
 *      restarts), persist to the `SessionEventJournal`, cache in an in-memory
 *      tail, fan out.
 *   5. Volatile events: fan out live with the current durable watermark as
 *      `seq` and `volatile: true`. Never journaled, never replayed.
 *   6. Exposes replay (`getBufferedSince`) keyed by `{seq, epoch}` cursors and
 *      an atomic `getSnapshotState` for the snapshot route.
 *
 * A session is activated (journaling starts) on first `subscribe` /
 * `getSnapshotState` / `getCursor` and stays active for the process lifetime so
 * the journal is continuous from first activation onward.
 */

import type {
  AgentActivitySnapshot,
  ApprovalResponse,
  DomainEvent,
  GlobalEvent,
  IAgentScopeHandle,
  IDisposable,
  Interaction,
  InteractionKind,
  ISessionActivity,
  ISessionScopeHandle,
  Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IAgentWireService,
  IEventBus,
  IEventService,
  ISessionActivity as ISessionActivityService,
  ISessionInteractionService,
  ISessionIndex,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import type {
  Event,
  InFlightTurn,
  ModelCatalogChangedEvent,
  SessionCreatedEvent,
  SessionCursor,
  SessionMetaUpdatedEvent,
  SessionStatus,
} from '@moonshot-ai/protocol';
import { isVolatileEventType } from '@moonshot-ai/protocol';

import { toWireApproval } from '../../../routes/approvals';
import { toWireQuestion } from '../../../routes/questions';
import {
  LegacyStatusModel,
  readLegacyStatus,
  toLegacyPhase,
} from '../../../services/legacyStatus/legacyStatus';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import {
  type EventEnvelope,
  type JournalLogger,
  SessionEventJournal,
  sessionJournalPath,
} from './sessionEventJournal';

export type ResyncReason = 'buffer_overflow' | 'session_recreated' | 'epoch_changed';

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /** When set, the client must rebuild from the snapshot and re-subscribe. */
  resyncRequired: ResyncReason | false;
  currentSeq: number;
  epoch: string;
}

export interface SessionSnapshotState {
  seq: number;
  epoch: string;
  inFlightTurn: InFlightTurn | null;
}

/** A connection (or test double) that receives sequenced envelopes. */
export interface BroadcastTarget {
  send(envelope: EventEnvelope): void;
}

/**
 * Per-subscription agent allowlist for fine-grained v1 event delivery.
 * `undefined` (or omitted) means "receive every agent" — the legacy
 * session-grained behavior. A `ReadonlySet` restricts delivery to the listed
 * agent ids; global events ({@link isGlobalEvent}) bypass the filter entirely.
 */
export type AgentFilter = ReadonlySet<string> | undefined;

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly activity?: ISessionActivity;
  /** Last status emitted (initialized from live session activity). */
  lastStatus?: SessionStatus;
  /** Recent durable envelopes for in-memory replay. */
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Connections subscribed to this session, each with its optional agent allowlist. */
  readonly targets: Map<BroadcastTarget, AgentFilter>;
  /** Per-session dispatch queue — serializes stamp / journal / fan-out. */
  queue: Promise<void>;
  /** agentId → sink subscription. */
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
  /** Interactions already announced (or pre-existing at activation): id → kind. */
  readonly knownInteractions: Map<string, InteractionKind>;
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;
const GLOBAL_SESSION_ID = '__global__';

async function disposeSessionState(state: SessionState): Promise<void> {
  for (const d of state.lifecycleDisposables) d.dispose();
  for (const d of state.agentDisposables.values()) d.dispose();
  await state.journal.close();
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxBufferSize: number;
  private readonly coreEventSubscription: IDisposable;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
  }

  /** Subscribe a connection to a session's stream (activates the session). */
  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
  ): Promise<boolean> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return false;
    state.targets.set(target, filter);
    return true;
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    this.sessions.get(sessionId)?.targets.delete(target);
  }

  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    // Drain so the cursor reflects everything dispatched so far.
    await state.queue;
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Stale / foreign cursor (e.g. from a different epoch or a pre-journal client).
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    // Filter is a view crop over the session's single durable sequence: the
    // watermark and overflow checks above stay global, only the returned
    // envelopes are narrowed to the subscriber's agent allowlist.
    const applyFilter = (
      entries: Array<{ seq: number; envelope: EventEnvelope }>,
    ): Array<{ seq: number; envelope: EventEnvelope }> =>
      filter === undefined
        ? entries
        : entries.filter(({ envelope }) => matchesAgentFilter(envelope, filter));

    // Serve from the memory tail when it fully covers the gap; else the journal.
    const tailStart = tail[0]?.seq;
    if (tailStart !== undefined && tailStart <= cursor.seq + 1) {
      const events = applyFilter(tail.filter((e) => e.seq > cursor.seq));
      return { events, resyncRequired: false, currentSeq, epoch };
    }
    const fromDisk = await journal.readSince(cursor.seq, this.maxBufferSize);
    return { events: applyFilter(fromDisk), resyncRequired: false, currentSeq, epoch };
  }

  async getCursor(sessionId: string): Promise<{ seq: number; epoch: string }> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId);
      return cold ?? { seq: 0, epoch: '' };
    }
    await state.queue;
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  /** Atomic-at-queue watermark + in-flight turn, for the snapshot route. */
  async getSnapshotState(sessionId: string): Promise<SessionSnapshotState> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      const cold = await this.readColdWatermark(sessionId);
      return cold !== undefined
        ? { ...cold, inFlightTurn: null }
        : { seq: 0, epoch: '', inFlightTurn: null };
    }
    await state.queue;
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      inFlightTurn: state.tracker.get(sessionId),
    };
  }

  /**
   * Watermark for a session that is not live in this process but exists on disk
   * (carried over from a prior process, or created by v1). Opens the journal
   * transiently — no agent/interaction listeners and not cached in
   * `this.sessions` — so a later live activation still attaches subscriptions.
   * Returns `undefined` when the session is unknown to the index (truly absent).
   */
  private async readColdWatermark(
    sessionId: string,
  ): Promise<{ seq: number; epoch: string } | undefined> {
    const summary = await this.opts.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    const watermark = { seq: journal.seq, epoch: journal.epoch };
    await journal.close();
    return watermark;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.coreEventSubscription.dispose();
    for (const state of this.sessions.values()) {
      await disposeSessionState(state);
    }
    this.sessions.clear();
  }

  private async ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return undefined;
    let state = this.sessions.get(sessionId);
    if (state !== undefined) return state;

    const session = this.opts.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    if (this.closed) {
      await journal.close();
      return undefined;
    }
    const activity = session.accessor.get(ISessionActivityService);
    state = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      activity,
      lastStatus: activity.status(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
    };
    this.sessions.set(sessionId, state);
    try {
      this.attachAgents(sessionId, session, state);
      this.attachInteractions(sessionId, session, state);
    } catch (error) {
      this.sessions.delete(sessionId);
      await disposeSessionState(state);
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') return undefined;
      throw error;
    }
    return state;
  }

  private async ensureGlobalState(): Promise<SessionState> {
    let state = this.sessions.get(GLOBAL_SESSION_ID);
    if (state !== undefined) return state;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, GLOBAL_SESSION_ID),
      this.opts.logger,
    );
    state = {
      sessionId: GLOBAL_SESSION_ID,
      journal,
      tracker: new InFlightTurnTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
    };
    this.sessions.set(GLOBAL_SESSION_ID, state);
    return state;
  }

  private onCoreEvent(event: GlobalEvent): void {
    if (event.type === 'event.model_catalog.changed') {
      const payload = modelCatalogChangedPayload(event.payload);
      if (payload === undefined) return;
      const modelEvent: ModelCatalogChangedEvent = {
        type: 'event.model_catalog.changed',
        ...payload,
      };
      void this.dispatchGlobal({
        ...modelEvent,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      });
      return;
    }
    if (event.type === 'event.session.created') {
      const payload = sessionCreatedPayload(event.payload);
      if (payload === undefined) return;
      // Forward creation to every connection (`isGlobalEvent` already matches
      // `event.session.*`), routed through the real session so the envelope
      // carries the real `session_id` (not the `__global__` watermark) — exactly
      // like `session.meta.updated` below. Without this, clients that didn't
      // issue the create never learn the session exists, so a later
      // `sessionStatusChanged` reducer is a no-op for the unknown session and
      // kimi-web's Stop button (gated on session.status === 'running') never
      // renders. Mirrors v1's `isGlobalSessionEvent` broadcast of creation.
      void this.dispatchSessionEvent(payload.sessionId, {
        type: 'event.session.created',
        session: payload.session,
        agentId: 'main',
        sessionId: payload.sessionId,
      } as Event);
      return;
    }
    if (event.type === 'session.meta.updated') {
      const payload = sessionMetaUpdatedPayload(event.payload);
      if (payload === undefined) return;
      // The originating session id travels on the core payload (the v1 protocol
      // event itself carries only title/patch). Recover it so the WS envelope is
      // addressed to the real session: routing through the global state would
      // stamp `session_id = '__global__'`, and clients would fail to match the
      // event to any sidebar session — so the auto-generated title (or a rename
      // from another client) would never appear. `isGlobalEvent` still fans the
      // dispatch out to every connection, so non-subscribed clients stay in sync
      // exactly like v1.
      const sessionId = sessionMetaUpdatedSessionId(event.payload);
      if (sessionId === undefined) return;
      void this.dispatchSessionEvent(sessionId, {
        type: 'session.meta.updated',
        ...payload,
        agentId: 'main',
        sessionId,
      } as Event);
    }
  }

  private async dispatchGlobal(event: Event): Promise<void> {
    const state = await this.ensureGlobalState();
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch(() => {});
  }

  /**
   * Dispatch an event through a real session's state so the WS envelope carries
   * the real `session_id` (not the global `'__global__'` watermark). Used for
   * session-scoped core events that must still fan out to every connection
   * (e.g. `session.meta.updated`); `isGlobalEvent` keeps the fan-out global.
   */
  private async dispatchSessionEvent(sessionId: string, event: Event): Promise<void> {
    let state: SessionState | undefined;
    try {
      state = await this.ensureState(sessionId);
    } catch (error) {
      // The session's core scope can be disposed mid-dispatch during shutdown;
      // the event is moot once its session is gone. Same guard as ensureState
      // applies around attach*, extended to the accessor reads above it.
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return;
      }
      throw error;
    }
    if (state === undefined) return;
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch(() => {});
  }

  private attachAgents(sessionId: string, session: ISessionScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      // Every domain emits live events via the per-agent `IEventBus`; the bus is
      // Agent-scoped, so this sees only this agent's events.
      const eventBus = handle.accessor.get(IEventBus);
      const busD = eventBus.subscribe((event) =>
        this.onAgentEvent(sessionId, handle.id, event),
      );
      const disposables: IDisposable[] = [busD];
      if (handle.id === MAIN_AGENT_ID) {
        disposables.push(this.attachLegacyStatus(sessionId, handle));
      }
      state.agentDisposables.set(handle.id, {
        dispose: () => disposables.forEach((d) => d.dispose()),
      });
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => subscribeAgent(handle)),
      agents.onDidDispose((agentId) => {
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          state.agentDisposables.delete(agentId);
        }
      }),
    );
  }

  /**
   * Bridge the v2 split status slices into a single v1-style combined
   * `agent.status.updated` event. The native v2 domains emit the usage /
   * context-window / model slices independently, so a usage-only event can
   * reach clients without the live contextTokens and overwrite it with a stale
   * zero. Attaching the {@link LegacyStatusModel} to the main agent's wire and
   * re-emitting a combined snapshot on every status-affecting Op keeps the
   * context window consistent on the wire.
   */
  private attachLegacyStatus(sessionId: string, handle: IAgentScopeHandle): IDisposable {
    const wire = handle.accessor.get(IAgentWireService);
    // The wire service is only present on a fully-materialized agent; stub /
    // test agents and not-yet-restored agents may not expose it, in which case
    // the native partial events are simply forwarded unchanged.
    if (wire === undefined) return { dispose: () => {} };
    const attachD = wire.attach(LegacyStatusModel);
    let lastEmitted: string | undefined;
    const subD = wire.subscribe(LegacyStatusModel, () => {
      const snapshot = readLegacyStatus(handle);
      // Dedupe: the derived model bumps on every watched Op, but only fan out
      // when the projected status actually changed.
      const key = JSON.stringify(snapshot);
      if (key === lastEmitted) return;
      lastEmitted = key;
      this.onAgentEvent(sessionId, MAIN_AGENT_ID, {
        type: 'agent.status.updated',
        ...snapshot,
      });
    });
    return {
      dispose: () => {
        subD.dispose();
        attachD.dispose();
      },
    };
  }

  private onAgentEvent(sessionId: string, agentId: string, event: DomainEvent): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;

    // Map the native v2 activity snapshot to the legacy v1 `agent.status.updated`
    // phase slice at the edge, so the v1 channel picks up the corrected
    // semantics (approval-set, idle-after-ended) without the core engine
    // carrying v1 compatibility. The core's own `agent.status.updated` phase
    // slice is dropped here to avoid duplicate phase events; other slices
    // (usage / context / plan / swarm) flow through unchanged.
    if (event.type === 'agent.activity.updated') {
      const phase = toLegacyPhase(event as unknown as AgentActivitySnapshot);
      if (phase !== undefined) {
        const wireEvent = {
          type: 'agent.status.updated',
          phase,
          agentId,
          sessionId,
        } as unknown as Event;
        state.queue = state.queue
          .then(() => this.dispatch(state, wireEvent, true))
          .catch(() => {});
      }
      return;
    }
    if (
      event.type === 'agent.status.updated' &&
      (event as { phase?: unknown }).phase !== undefined
    ) {
      return;
    }

    // The migrated agent events are AgentEvent-shaped by construction (they were
    // ported from the former `record.signal(agentEvent)` call sites); the declared
    // `DomainEventMap` payload types are deliberately wider than the protocol
    // contract, hence the assertion via `unknown`.
    const wireEvent = { ...event, agentId, sessionId } as unknown as Event;
    // Session status transitions are synthesized only from the MAIN agent's turn
    // boundaries. Subagents share the session channel (their frames carry their
    // own agentId and clients route them to the task view), so a subagent's
    // turn.ended would otherwise emit a bogus `status_changed(idle)` mid-turn:
    // the client reads that as "the turn finished" (driving notifications,
    // sounds, unread dots and the queued-message drain), and the real turn end
    // is then swallowed by dedup. Same main-only rule as InFlightTurnTracker.
    if (agentId === MAIN_AGENT_ID && event.type === 'turn.started') {
      // Status is authoritative protocol state: emit it before the turn event so
      // clients enter running first. A pending interaction remains higher
      // priority than running.
      this.enqueueStatusChanged(state, pendingStatus(state.activity?.status()) ?? 'running');
    }
    const volatile = isVolatileSignal(event.type);
    state.queue = state.queue
      .then(() => this.dispatch(state, wireEvent, volatile))
      .catch(() => {});
    if (agentId === MAIN_AGENT_ID && event.type === 'turn.ended') {
      // Emit completion after the turn event. Pending interactions remain higher
      // priority; otherwise failed/cancelled/blocked turns abort and all others
      // become idle.
      const reason = (event as { reason?: unknown }).reason;
      const terminalStatus =
        reason === 'cancelled' || reason === 'failed' || reason === 'blocked' ? 'aborted' : 'idle';
      this.enqueueStatusChanged(state, pendingStatus(state.activity?.status()) ?? terminalStatus);
    }
    // v1 wire compat: fan the legacy `background.task.*` spelling out next to
    // the native `task.*` event (see `legacyTaskEvent`) so unchanged v1 clients
    // keep working while v2-shaped clients ignore the alias. Same volatility as
    // the native event so replay/journal/filter stay coherent between the two.
    const legacy = legacyTaskEvent(event, agentId, sessionId);
    if (legacy !== undefined) {
      state.queue = state.queue
        .then(() => this.dispatch(state, legacy, volatile))
        .catch(() => {});
    }
  }

  /**
   * Bridge the session's interaction kernel (approvals / questions) onto the
   * v1 event stream. The kernel only emits in-process notifications
   * (`onDidChangePending` / `onDidResolve`), so the v1 protocol events and their
   * authoritative session status transitions are synthesized here.
   */
  private attachInteractions(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const interactions = session.accessor.get(ISessionInteractionService);
    // Seed silently: interactions already pending at activation are surfaced
    // by the snapshot route (`pending_questions` / `pending_approvals`), and
    // lastStatus was initialized from the same live activity state.
    for (const i of interactions.listPending()) {
      state.knownInteractions.set(i.id, i.kind);
    }
    state.lifecycleDisposables.push(
      interactions.onDidChangePending(() => {
        for (const i of interactions.listPending()) {
          if (state.knownInteractions.has(i.id)) continue;
          state.knownInteractions.set(i.id, i.kind);
          const event = interactionRequestedEvent(i, sessionId);
          if (event !== undefined) {
            this.enqueueDurable(state, event);
            this.enqueueStatusChanged(state, state.activity!.status());
          }
        }
      }),
      interactions.onDidResolve(({ id, response }) => {
        const kind = state.knownInteractions.get(id);
        if (kind === undefined) return;
        state.knownInteractions.delete(id);
        const event = interactionResolvedEvent(kind, id, response, sessionId);
        if (event !== undefined) {
          this.enqueueDurable(state, event);
          this.enqueueStatusChanged(state, state.activity!.status());
        }
      }),
    );
  }

  private enqueueDurable(state: SessionState, event: Event): void {
    state.queue = state.queue.then(() => this.dispatch(state, event, false)).catch(() => {});
  }

  private enqueueStatusChanged(state: SessionState, status: SessionStatus): void {
    state.queue = state.queue
      .then(async () => {
        const previousStatus = state.lastStatus;
        if (previousStatus === undefined || status === previousStatus) return;
        state.lastStatus = status;
        await this.dispatch(
          state,
          {
            type: 'event.session.status_changed',
            status,
            previous_status: previousStatus,
            agentId: 'main',
            sessionId: state.sessionId,
          } as Event,
          false,
        );
      })
      .catch(() => {});
  }

  private async dispatch(state: SessionState, event: Event, volatile: boolean): Promise<void> {
    const { journal, tracker, tail, targets, sessionId } = state;
    const annotation = tracker.apply(sessionId, event);

    let envelope: EventEnvelope;
    if (volatile) {
      envelope = this.buildEnvelope(journal.seq, sessionId, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = this.buildEnvelope(seq, sessionId, event, { epoch: journal.epoch });
      journal.append(seq, envelope);
      tail.push({ seq, envelope });
      while (tail.length > this.maxBufferSize) tail.shift();
    }

    if (isGlobalEvent(event.type)) {
      // Global events (session/workspace/config/model-catalog) are not agent
      // events — fan out to every subscriber regardless of any agent filter.
      for (const target of this.allTargets()) {
        try {
          target.send(envelope);
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    } else {
      for (const [target, filter] of targets) {
        if (!matchesAgentFilter(envelope, filter)) continue;
        try {
          target.send(envelope);
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    }
  }

  private buildEnvelope(
    seq: number,
    sessionId: string,
    event: Event,
    extras: { epoch?: string; volatile?: boolean; offset?: number },
  ): EventEnvelope {
    return {
      type: event.type,
      seq,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: event,
      ...extras,
    };
  }

  private *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets.keys()) yield target;
    }
  }
}

/**
 * Server-side durability gate for the agent event path. Live events reach the
 * edge via the per-agent `IEventBus`; their volatile vs durable
 * classification is owned here rather than by the protocol's
 * `VOLATILE_EVENT_TYPES` / `isVolatileEventType` (still used by the global /
 * model path in `dispatchGlobal`, and by the shipped v1 server). Volatile set
 * per plan line 475.
 */
const VOLATILE_SIGNAL_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'agent.status.updated',
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(VOLATILE_SIGNAL_TYPES);

function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

/**
 * v1 wire compatibility: map a native v2 background-task lifecycle event to its
 * pre-v2 spelling, returning `undefined` for every other event. The pre-v2
 * engine emitted `background.task.started`/`background.task.terminated`; v2
 * emits `task.started`/`task.terminated`. The payload (`info`) is kept
 * byte-identical and `agentId`/`sessionId` are re-stamped so the alias flows
 * through the same dispatch / journal / agent-filter path as the native event.
 *
 * Exists so unchanged v1 consumers (kimi-code TUI / `kimi -p`, node-sdk) keep
 * working while v2-shaped consumers (kimi-web) keep the native event and ignore
 * the alias (registered as known, no handler). Remove once every consumer has
 * migrated to `task.*`.
 */
function legacyTaskEvent(event: DomainEvent, agentId: string, sessionId: string): Event | undefined {
  if (event.type !== 'task.started' && event.type !== 'task.terminated') return undefined;
  const legacyType =
    event.type === 'task.started' ? 'background.task.started' : 'background.task.terminated';
  return { ...event, type: legacyType, agentId, sessionId } as unknown as Event;
}

function pendingStatus(status: SessionStatus | undefined): SessionStatus | undefined {
  return status === 'awaiting_approval' || status === 'awaiting_question' ? status : undefined;
}

/** Session/workspace/config/model-catalog events are broadcast to every connection. */
function isGlobalEvent(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.') ||
    type.startsWith('event.model_catalog.')
  );
}

/**
 * Per-subscription agent allowlist check — shared by live fan-out and replay.
 * Returns `true` when the envelope should be delivered to a subscriber carrying
 * `filter`:
 *   - `filter === undefined` → receive every agent (legacy session-grained
 *     behavior);
 *   - global events (session/workspace/config/model-catalog) are not agent
 *     events and always pass;
 *   - events without a string `agentId` (should not happen on the v1 wire,
 *     where the broadcaster stamps every event) pass defensively rather than
 *     being dropped;
 *   - otherwise the envelope's `payload.agentId` must be in the allowlist.
 */
function matchesAgentFilter(envelope: EventEnvelope, filter: AgentFilter): boolean {
  if (filter === undefined) return true;
  if (isGlobalEvent(envelope.type)) return true;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return true;
  return filter.has(agentId);
}

// ---------------------------------------------------------------------------
// Interaction → v1 protocol event synthesis. Event names and payload shapes
// mirror v1's question/approval services
// (`packages/server/src/services/{question,approval}/*Service.ts`); the wire
// request bodies are the same projections the REST/snapshot routes use.
// ---------------------------------------------------------------------------

function interactionRequestedEvent(interaction: Interaction, sessionId: string): Event | undefined {
  const agentId = interaction.origin.agentId ?? 'main';
  switch (interaction.kind) {
    case 'question':
      return {
        type: 'event.question.requested',
        agentId,
        sessionId,
        ...toWireQuestion(interaction, sessionId),
      } as unknown as Event;
    case 'approval':
      return {
        type: 'event.approval.requested',
        agentId,
        sessionId,
        ...toWireApproval(interaction, sessionId),
      } as unknown as Event;
    default:
      // 'user_tool' has no v1 protocol event.
      return undefined;
  }
}

function interactionResolvedEvent(
  kind: InteractionKind,
  id: string,
  response: unknown,
  sessionId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case 'question': {
      // `null` marks a dismissal (see `ISessionQuestionService.dismiss`).
      if (response === null) {
        return {
          type: 'event.question.dismissed',
          agentId: 'main',
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      // `QuestionResult` is either `{ answers, method? }` or a bare answers record.
      const answers = (response as { answers?: unknown }).answers ?? response;
      return {
        type: 'event.question.answered',
        agentId: 'main',
        sessionId,
        question_id: id,
        answers,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    case 'approval': {
      const r = response as Partial<ApprovalResponse>;
      return {
        type: 'event.approval.resolved',
        agentId: 'main',
        sessionId,
        approval_id: id,
        decision: r.decision,
        scope: r.scope,
        feedback: r.feedback,
        selected_label: r.selectedLabel,
        resolved_at: resolvedAt,
      } as unknown as Event;
    }
    default:
      return undefined;
  }
}

function modelCatalogChangedPayload(
  payload: unknown,
): Pick<ModelCatalogChangedEvent, 'changed' | 'unchanged' | 'failed'> | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<ModelCatalogChangedEvent>;
  if (
    !Array.isArray(candidate.changed) ||
    !Array.isArray(candidate.unchanged) ||
    !Array.isArray(candidate.failed)
  ) {
    return undefined;
  }
  return {
    changed: candidate.changed,
    unchanged: candidate.unchanged,
    failed: candidate.failed,
  };
}

/**
 * Validate the `session.meta.updated` payload published on the core
 * `IEventService`. Both the first-prompt auto-title path
 * (`agent-core-v2`'s `applyPromptMetadataUpdate`) and the
 * `POST /sessions/{id}/profile` rename route wrap the v1 fields under
 * `payload` alongside `agentId`/`sessionId`; we unwrap the title/patch here
 * and re-attach `agentId`/`sessionId` at the edge.
 */
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

/** Recover the originating session id carried on the core payload. */
function sessionMetaUpdatedSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Validate the `event.session.created` payload published on the core
 * `IEventService`. The create/fork/child routes publish
 * `{ agentId, sessionId, session }`; we unwrap the real session id and wire
 * session here and re-attach `agentId`/`sessionId` at the edge.
 */
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
