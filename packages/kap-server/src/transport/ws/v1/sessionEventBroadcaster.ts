import type {
  AgentActivityState,
  ApprovalResponse,
  Event2,
  IAgentScopeHandle,
  IDisposable,
  Interaction,
  InteractionKind,
  ISessionScopeHandle,
  Scope,
  SessionActivityState,
  Workspace,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IEventBus,
  IEventService,
  ISessionActivityView,
  ISessionIndex,
  MAIN_AGENT_ID,
  getLiveSessionById,
  listSessionPendingInteractions,
  onSessionInteractionDidChangePending,
  onSessionInteractionDidResolve,
} from '@moonshot-ai/agent-core-v2';
import type {
  ConfigWarningItem,
  DiUnitChangedEvent,
  SessionCreatedEvent,
  SessionMetaUpdatedEvent,
  Event,
} from './events';
import { isVolatileEventType } from './events';
import type { SessionCursor } from '../../../protocol/ws-control';
import type { InFlightTurn, SnapshotSubagent } from '../../../protocol/rest-snapshot';
import {
  detachGrades,
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

import { toWireApproval } from '../../../routes/approvals';
import { toWireQuestion } from '../../../routes/questions';
import { toWireWorkspace } from '../../../routes/workspaces';
import { projectPromptContentParts } from '../../../services/messages/messageProjection';
import { readLegacyStatus, toLegacyPhase } from '../../../services/legacyStatus/legacyStatus';
import type { TranscriptService } from '../../../services/transcript/transcriptService';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import { SubagentRosterTracker } from './subagentRosterTracker';
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
  subagents: SnapshotSubagent[];
}

/** Internal transport lane: only subscription traffic enters the timed buffer. */
export type BroadcastDelivery = 'subscription' | 'immediate';

/** A connection (or test double) that receives sequenced envelopes. */
export interface BroadcastTarget {
  send(envelope: EventEnvelope, delivery?: BroadcastDelivery): void;
}

/**
 * Per-subscription agent allowlist for fine-grained v1 event delivery.
 * `undefined` (or omitted) means "receive every agent" — the legacy
 * session-grained behavior. A `ReadonlySet` restricts delivery to the listed
 * agent ids; global events ({@link isGlobalEvent}) bypass the filter entirely.
 */
export type AgentFilter = ReadonlySet<string> | undefined;

/**
 * What one connection wants from a session: two independent dimensions. The
 * legacy agent allowlist gates `session_event` delivery only; the opt-in
 * per-agent transcript grades (`Record<agentId|'*', grade>`; absent = all
 * 'off' — legacy clients see no transcript frames at all) alone decide which
 * agents' transcript frames the connection receives — the allowlist does NOT
 * gate the transcript stream.
 */
export interface TargetSubscription {
  readonly agentFilter?: AgentFilter;
  readonly transcriptGrades?: TranscriptGradeSpec;
}

interface TranscriptStream {
  readonly store: TranscriptStore;
  readonly knownAgents: Set<string>;
}

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly roster: SubagentRosterTracker;
  deferredWork?: SessionActivityState;
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  queue: Promise<void>;
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
  readonly knownInteractions: Map<string, { readonly kind: InteractionKind; readonly agentId: string }>;
  transcriptStream?: TranscriptStream;
  readonly transcriptSeeded: Set<BroadcastTarget>;
  readonly deferredTranscriptSeeds: Map<
    BroadcastTarget,
    { readonly spec: TranscriptGradeSpec; readonly transcriptSince?: Record<string, number> }
  >;
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;
const GLOBAL_SESSION_ID = '__global__';
const TRANSCRIPT_RESET_TAIL_TURNS = 0;

async function disposeSessionState(state: SessionState): Promise<void> {
  for (const d of state.lifecycleDisposables) d.dispose();
  for (const d of state.agentDisposables.values()) d.dispose();
  await state.journal.close();
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Every established connection, subscribed or not. Global events
   * ({@link isGlobalEvent}) fan out to this set (union the per-session
   * targets) so a freshly connected client sees session-level facts —
   * `event.session.created`, `session.meta.updated`, and every activated
   * session's `event.session.work_changed` — without subscribing to anything.
   */
  private readonly globalTargets = new Set<BroadcastTarget>();
  /**
   * Opt-in set for the `event.di.*` debug-surface feed. That feed is global
   * (no owning session) and high-churn, but only kimi-inspect's DI view
   * consumes it — pushing it to every connection wastes bandwidth on clients
   * that drop the frames unread. Temporary gate until a client-declared
   * event-type whitelist exists: `WsConnectionV1` opts a connection in when
   * its `client_hello` carries `client_id: 'kimi-inspect'`; every other
   * connection (including subscribed targets) skips `event.di.*` frames.
   */
  private readonly diEventTargets = new Set<BroadcastTarget>();
  /**
   * Single-flight guard for session activation: without it, two concurrent
   * activations (WS subscribe racing a REST snapshot / replay / resync) each
   * built their own SessionState, bus subscriptions, and journal writer. The
   * leaked listeners all route through `onAgentEvent`, which looks up the
   * current state by session id, so they advance the SAME tracker and journal:
   * one source delta is emitted at consecutive offsets and adjacent durable
   * events receive distinct consecutive seqs. WS coalescing then folds the
   * adjacent delta copies into one doubled payload, producing the observed
   * per-chunk `AABBCC` stream while every seq and offset still looks valid.
   */
  private readonly pendingStates = new Map<string, Promise<SessionState | undefined>>();
  private readonly maxBufferSize: number;
  private readonly coreEventSubscription: IDisposable;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
      readonly transcriptService?: TranscriptService;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
  }

  /**
   * Register a freshly established connection for global-event fan-out. The
   * connection receives every global event ({@link isGlobalEvent}) from this
   * point on, with no per-session subscription required. Idempotent.
   */
  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  /** Drop a closed connection from the global fan-out set. Idempotent. */
  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
    this.diEventTargets.delete(target);
  }

  /**
   * Opt a connection into the `event.di.*` debug-surface feed (see
   * {@link diEventTargets}). Idempotent; cleaned up by
   * {@link removeGlobalTarget}.
   */
  addDiEventTarget(target: BroadcastTarget): void {
    this.diEventTargets.add(target);
  }

  /**
   * Subscribe a connection to a session's stream (activates the session).
   *
   * When `transcriptGrades` is present the connection also joins the
   * session's transcript stream: every already-known agent whose grade is not
   * 'off' and that is an upgrade over the connection's previous grade
   * (`needsResetOnTransition`) is seeded with a `transcript.reset` snapshot;
   * later ops arrive as `transcript.ops`. Transcript frames are ALWAYS
   * volatile (current watermark as seq, never journaled, never replayed) —
   * frame loss surfaces through the ordinary backpressure → `resync_required`
   * → REST + re-subscribe path, which resets the transcript naturally.
   */
  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    opts?: { deferTranscriptReset?: boolean; transcriptSince?: Record<string, number> },
  ): Promise<boolean> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return false;
    const prev = state.targets.get(target);
    state.targets.set(target, { agentFilter: filter, transcriptGrades });
    if (transcriptGrades !== undefined) {
      if (opts?.deferTranscriptReset === true) {
        state.transcriptSeeded.delete(target);
        state.deferredTranscriptSeeds.set(target, {
          spec: transcriptGrades,
          transcriptSince: opts.transcriptSince,
        });
      } else {
        state.deferredTranscriptSeeds.delete(target);
        const gated = this.willSendTranscriptReset(state, transcriptGrades, prev);
        if (gated) state.transcriptSeeded.delete(target);
        await this.subscribeTranscript(
          state,
          target,
          transcriptGrades,
          prev?.transcriptGrades,
          opts?.transcriptSince,
        );
        if (state.targets.has(target)) state.transcriptSeeded.add(target);
      }
    }
    return true;
  }

  /**
   * Whether `subscribeTranscript` will send at least one reset for this
   * (target, spec) pair right now — an upgrade over the previous grades.
   */
  private willSendTranscriptReset(
    state: SessionState,
    spec: TranscriptGradeSpec,
    prev: TargetSubscription | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    for (const descriptor of store.agents()) {
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === 'off') continue;
      if (needsResetOnTransition(gradeFor(prev?.transcriptGrades, descriptor.agentId), grade)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send the transcript baseline deferred by `subscribe(deferTranscriptReset)`
   * — callers run it after their cursor replay so the reset never lands ahead
   * of the replayed (lower-seq) backlog. The baseline is forced for every
   * admitted agent (no previous grades): volatile ops fanned out while the
   * target sat unseeded were dropped, so only a full reset closes that gap —
   * unless the subscription carried a `transcriptSince` cursor the journal
   * still covers, in which case replaying exactly the missed batches closes
   * it and no reset is sent for that agent.
   */
  async flushTranscriptSeed(sessionId: string, target: BroadcastTarget): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const deferred = state.deferredTranscriptSeeds.get(target);
    if (deferred === undefined) return;
    state.deferredTranscriptSeeds.delete(target);
    await this.subscribeTranscript(state, target, deferred.spec, undefined, deferred.transcriptSince);
    if (state.targets.has(target)) state.transcriptSeeded.add(target);
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.targets.delete(target);
    state.transcriptSeeded.delete(target);
    state.deferredTranscriptSeeds.delete(target);
  }

  /**
   * Detach one connection's transcript grade stream — agent-grained. With
   * `agentIds`, only the listed agents drop to an explicit 'off' (a listed
   * '*' removes the wildcard default); without it, the whole stream goes.
   * Non-activating and idempotent: unknown sessions/targets are no-ops. A
   * detached agent stops streaming on the next ops batch and its legacy
   * session_events resume automatically (both paths re-read the per-agent
   * grade); when no non-'off' grade remains the spec collapses to
   * `undefined`, the seeded/deferred baselines are dropped, and any in-flight
   * `subscribeTranscript` aborts on its grade re-read.
   */
  unsubscribeTranscript(
    sessionId: string,
    target: BroadcastTarget,
    agentIds?: readonly string[],
  ): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const sub = state.targets.get(target);
    if (sub === undefined) return;
    const next =
      agentIds === undefined ? undefined : detachGrades(sub.transcriptGrades, agentIds);
    if (next === undefined) {
      state.targets.set(target, { agentFilter: sub.agentFilter, transcriptGrades: undefined });
      state.transcriptSeeded.delete(target);
      state.deferredTranscriptSeeds.delete(target);
    } else {
      state.targets.set(target, { agentFilter: sub.agentFilter, transcriptGrades: next });
    }
  }

  /**
   * Handle one connection's transcript subscription: attach the shared
   * per-session stream on first use and send `transcript.reset` snapshots for
   * every known agent admitted by `spec` that is an upgrade over the
   * connection's previous grade. A cold session (not live in this process)
   * silently skips streaming — cold transcripts stay REST-only. Live sessions
   * first await the initial wire-records backfill, so the seeded resets carry
   * the established main-agent transcript. Explicitly graded agents AND roster
   * agents admitted via the wildcard get their persisted history replayed
   * before their first reset — a roster agent whose `AgentTranscript` was
   * never materialized has nothing to snapshot, so without the backfill its
   * baseline is silently skipped. Grades are re-read from `state.targets`
   * after the awaits: subscribe work runs asynchronously, and a newer
   * subscribe/unsubscribe must not be answered with stale resets.
   */
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
    const current = state.targets.get(target);
    if (current?.transcriptGrades === undefined) return;
    const currentSpec = current.transcriptGrades;
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
      if (!needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade)) {
        continue;
      }
      this.sendTranscriptReset(state, target, transcript, grade);
    }
  }

  /**
   * Replay journaled op batches to one connection (the `transcript_since`
   * catch-up path), grade-filtered like the live fan-out and stamped with
   * their original batch seqs.
   */
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
          this.buildTranscriptEnvelope(state, 'transcript.ops', {
            agent_id: agentId,
            ops: filtered,
            seq: batch.seq,
          }),
        );
      } catch {
      }
    }
  }

  /**
   * Attach the session's shared transcript fan-out: one mapped-ops
   * subscription for the whole session (grade filtering happens per target at
   * fan-out). New agents appearing later seed a `transcript.reset` for every
   * connected target whose grade admits them. The attachment is pinned to the
   * store instance: when the engine session closes, the service drops the
   * store together with its ops listener set while this session state
   * survives, so a subscribe after an in-daemon session resume must
   * re-register the fan-out against the rebuilt store — returning early on
   * any stale stream would deliver resets but never the live ops.
   */
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
      for (const [target, sub] of state.targets) {
        if (!state.transcriptSeeded.has(target)) continue;
        const grade = gradeFor(sub.transcriptGrades, agentId);
        const filtered = filterOpsForGrade(grade, ops);
        if (filtered.length === 0) continue;
        try {
          target.send(
            this.buildTranscriptEnvelope(state, 'transcript.ops', {
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
          for (const [target, sub] of state.targets) {
            if (!state.transcriptSeeded.has(target)) continue;
            const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
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

  /**
   * Volatile `transcript.reset` baseline: an items-empty snapshot (global
   * state only, redacted to the target's grade) plus the seq watermark.
   * History is paged over REST; live ops stream from the watermark.
   */
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
      this.buildTranscriptEnvelope(state, 'transcript.reset', {
        agent_id: transcript.agentId,
        snapshot,
        has_more_older: snapshot.hasMoreOlder ?? false,
        seq: this.opts.transcriptService?.getSeqWatermark(state.sessionId, transcript.agentId),
      }),
    );
  }

  /**
   * All transcript frames are volatile and carry the current durable watermark
   * as `seq` (they never advance it and are never journaled or replayed). The
   * payload is the flat protocol event (`{ type, agent_id, … }`), matching the
   * `transcriptResetEventSchema` / `transcriptOpsEventSchema` shapes.
   */
  private buildTranscriptEnvelope(
    state: SessionState,
    type: 'transcript.reset' | 'transcript.ops',
    payload: Omit<TranscriptResetEvent, 'type'> | Omit<TranscriptOpsEvent, 'type'>,
  ): EventEnvelope {
    return {
      type,
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      volatile: true,
      session_id: state.sessionId,
      timestamp: new Date().toISOString(),
      payload: { type, ...payload },
    };
  }

  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    await state.queue;
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    const applyFilter = (
      entries: Array<{ seq: number; envelope: EventEnvelope }>,
    ): Array<{ seq: number; envelope: EventEnvelope }> =>
      filter === undefined && transcriptGrades === undefined
        ? entries
        : entries.filter(
            ({ envelope }) =>
              matchesAgentFilter(envelope, filter) &&
              !suppressedByTranscript(envelope, transcriptGrades),
          );

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
        ? { ...cold, inFlightTurn: null, subagents: [] }
        : { seq: 0, epoch: '', inFlightTurn: null, subagents: [] };
    }
    await state.queue;
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      inFlightTurn: state.tracker.get(sessionId),
      subagents: state.roster.get(sessionId),
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
    for (const [sessionId, state] of this.sessions) {
      await disposeSessionState(state);
      this.opts.transcriptService?.dropSession(sessionId);
    }
    this.sessions.clear();
  }

  private ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(sessionId);
    if (pending === undefined) {
      pending = this.createSessionState(sessionId).finally(() => {
        if (this.pendingStates.get(sessionId) === pending) {
          this.pendingStates.delete(sessionId);
        }
      });
      this.pendingStates.set(sessionId, pending);
    }
    return pending;
  }

  private async createSessionState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return undefined;

    const session = getLiveSessionById(this.opts.core.accessor, sessionId);
    if (session === undefined) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    if (this.closed) {
      await journal.close();
      return undefined;
    }
    const state: SessionState = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(sessionId, state);
    try {
      this.attachWorkView(session, state);
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

  private ensureGlobalState(): Promise<SessionState> {
    const existing = this.sessions.get(GLOBAL_SESSION_ID);
    if (existing !== undefined) return Promise.resolve(existing);
    let pending = this.pendingStates.get(GLOBAL_SESSION_ID);
    if (pending === undefined) {
      pending = this.createGlobalState().finally(() => {
        if (this.pendingStates.get(GLOBAL_SESSION_ID) === pending) {
          this.pendingStates.delete(GLOBAL_SESSION_ID);
        }
      });
      this.pendingStates.set(GLOBAL_SESSION_ID, pending);
    }
    return pending as Promise<SessionState>;
  }

  private async createGlobalState(): Promise<SessionState> {
    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, GLOBAL_SESSION_ID),
      this.opts.logger,
    );
    const state: SessionState = {
      sessionId: GLOBAL_SESSION_ID,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      tail: [],
      targets: new Map(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
      knownInteractions: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
    };
    this.sessions.set(GLOBAL_SESSION_ID, state);
    return state;
  }

  private onCoreEvent(event: Event2<any>): void {
    const corePayload = (event as { readonly payload?: unknown }).payload;
    if (event.type === 'event.session.created') {
      const payload = sessionCreatedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchSessionEvent(payload.sessionId, {
        type: 'event.session.created',
        session: payload.session,
        agentId: 'main',
        sessionId: payload.sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(payload.sessionId, 'event.session.created', error),
      );
      return;
    }
    if (event.type === 'event.session.archived') {
      const payload = sessionArchivedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.session.archived',
        workspace_id: payload.workspaceId,
        agentId: 'main',
        sessionId: payload.sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.session.archived', error),
      );
      return;
    }
    if (event.type === 'event.workspace.created' || event.type === 'event.workspace.updated') {
      const workspace = workspaceLifecyclePayload(corePayload);
      if (workspace === undefined) return;
      const type = event.type;
      void (async () => {
        const wire = await toWireWorkspace(this.opts.core, workspace);
        await this.dispatchGlobal({
          type,
          workspace: wire,
          agentId: 'main',
          sessionId: GLOBAL_SESSION_ID,
        } as Event);
      })().catch((error: unknown) => this.logDispatchError(GLOBAL_SESSION_ID, type, error));
      return;
    }
    if (event.type === 'event.workspace.deleted') {
      const payload = workspaceDeletedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.workspace.deleted',
        workspace_id: payload.workspaceId,
        root: payload.root,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.workspace.deleted', error),
      );
      return;
    }
    if (event.type === 'session.meta.updated') {
      const payload = sessionMetaUpdatedPayload(corePayload);
      if (payload === undefined) return;
      const sessionId = sessionMetaUpdatedSessionId(corePayload);
      if (sessionId === undefined) return;
      void this.dispatchSessionEvent(sessionId, {
        type: 'session.meta.updated',
        ...payload,
        agentId: 'main',
        sessionId,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(sessionId, 'session.meta.updated', error),
      );
      return;
    }
    if (event.type === 'event.plugin.changed') {
      void this.dispatchGlobal({
        type: 'event.plugin.changed',
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.plugin.changed', error),
      );
      return;
    }
    if (event.type === 'event.capability.changed') {
      const payload = capabilityChangedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.capability.changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.capability.changed', error),
      );
      return;
    }
    if (event.type === 'event.config.warning') {
      const payload = configWarningPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.config.warning',
        warnings: payload.warnings,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.config.warning', error),
      );
      return;
    }
    if (event.type === 'event.di.unit_changed') {
      const payload = diUnitChangedPayload(corePayload);
      if (payload === undefined) return;
      void this.dispatchGlobal({
        type: 'event.di.unit_changed',
        ...payload,
        agentId: 'main',
        sessionId: GLOBAL_SESSION_ID,
      } as Event).catch((error: unknown) =>
        this.logDispatchError(GLOBAL_SESSION_ID, 'event.di.unit_changed', error),
      );
      return;
    }
  }

  private async dispatchGlobal(event: Event): Promise<void> {
    const state = await this.ensureGlobalState();
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
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
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return;
      }
      throw error;
    }
    if (state === undefined) return;
    state.queue = state.queue
      .then(() => this.dispatch(state, event, isVolatileEventType(event.type)))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  /**
   * Bridge the core's session work aggregate (`ISessionActivityView`) onto
   * the v1 `event.session.work_changed` frame. The view owns the fold and
   * its change dedup; the edge only schedules the wire emission. Every cause
   * except `turn_ended` emits immediately. A `turn_ended` change must land
   * after the matching `turn.ended` frame, but the agent bus fires
   * full-stream subscribers (the edge's own handler) before per-type ones
   * (the activity view chain that reports this change) — so the state is
   * buffered and flushed from a microtask: the microtask runs after the
   * whole synchronous publish, by which time the `turn.ended` frame is
   * already enqueued on the session queue, and the emission can never be
   * stranded behind a flush that already ran.
   */
  private attachWorkView(session: ISessionScopeHandle, state: SessionState): void {
    const workView = session.accessor.get(ISessionActivityView);
    workView.state();
    state.lifecycleDisposables.push(
      workView.onDidChange(({ state: work, cause }) => {
        if (cause === 'turn_ended') {
          state.deferredWork = work;
          queueMicrotask(() => {
            if (this.sessions.get(state.sessionId) !== state) return;
            this.flushDeferredWork(state);
          });
          return;
        }
        this.flushDeferredWork(state);
        this.enqueueWorkChanged(state, work);
      }),
    );
  }

  private flushDeferredWork(state: SessionState): void {
    const deferred = state.deferredWork;
    if (deferred === undefined) return;
    state.deferredWork = undefined;
    this.enqueueWorkChanged(state, deferred);
  }

  private attachAgents(sessionId: string, session: ISessionScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      state.agentDisposables.set(handle.id, this.attachAgent(sessionId, handle));
    };
    for (const agent of agents.list()) {
      const handle = agents.handleOf(agent.agentId);
      if (handle !== undefined) subscribeAgent(handle);
    }
    state.lifecycleDisposables.push(
      agents.onDidCreate((context) => {
        const handle = agents.handleOf(context.agentId);
        if (handle !== undefined) subscribeAgent(handle);
        this.enqueueDurable(state, {
          type: 'agent.created',
          agentId: context.agentId,
          sessionId,
        });
      }),
      agents.onDidClose((context) => {
        const agentId = context.agentId;
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          state.agentDisposables.delete(agentId);
          this.enqueueDurable(state, {
            type: 'agent.disposed',
            agentId,
            sessionId,
          });
        }
      }),
    );
  }

  private attachAgent(sessionId: string, handle: IAgentScopeHandle): IDisposable {
    const eventBus = handle.accessor.get(IEventBus);
    let lastLegacyStatus: string | undefined;
    const emitLegacyStatus = (): void => {
      const snapshot = readLegacyStatus(handle);
      if (snapshot === undefined) return;
      const key = JSON.stringify(snapshot);
      if (key === lastLegacyStatus) return;
      lastLegacyStatus = key;
      this.onAgentEvent(sessionId, MAIN_AGENT_ID, {
        type: 'agent.status.updated',
        ...snapshot,
      } as unknown as Event2<any>);
    };
    const disposables: IDisposable[] = [
      eventBus.subscribe((event) => {
        let projected: Event2<any> = event;
        if (event.type === 'agent.status.updated') {
          const snapshot = readLegacyStatus(handle);
          if (snapshot !== undefined) {
            lastLegacyStatus = JSON.stringify(snapshot);
            projected = Object.assign({}, event, snapshot) as unknown as Event2<any>;
          }
        }
        if (handle.id === MAIN_AGENT_ID && event.type === 'context.spliced') {
          emitLegacyStatus();
        }
        this.onAgentEvent(sessionId, handle.id, projected);
      }),
    ];

    return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
  }

  private onAgentEvent(sessionId: string, agentId: string, event: Event2<any>): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;

    if (event.type === 'prompt.accepted') return;

    if (event.type === 'agent.activity.updated') {
      const snapshot = event as unknown as AgentActivityState;
      const phase = toLegacyPhase(snapshot);
      if (phase !== undefined) {
        const wireEvent = {
          type: 'agent.status.updated',
          phase,
          agentId,
          sessionId,
        } as unknown as Event;
        state.queue = state.queue
          .then(() => this.dispatch(state, wireEvent, true))
          .catch((error: unknown) => this.logDispatchDropped(state.sessionId, wireEvent.type, error));
      }
      return;
    }
    if (
      event.type === 'agent.status.updated' &&
      (event as { phase?: unknown }).phase !== undefined
    ) {
      return;
    }

    let wireEvent: Event;
    if (event.type === 'turn.started') {
      const { promptAttachments: _internal, ...wireFields } = event as typeof event & {
        promptAttachments?: unknown;
      };
      wireEvent = Object.assign({}, wireFields, { agentId, sessionId }) as unknown as Event;
    } else if (event.type === 'prompt.steered' || event.type === 'prompt.queued') {
      const content = (event as unknown as { content: Parameters<typeof projectPromptContentParts>[0] }).content;
      wireEvent = Object.assign({}, event, {
        content: projectPromptContentParts(content),
        agentId,
        sessionId,
      }) as unknown as Event;
    } else {
      wireEvent = Object.assign({}, event, { agentId, sessionId }) as unknown as Event;
    }
    const volatile = isVolatileSignal(event.type);
    state.queue = state.queue
      .then(() => this.dispatch(state, wireEvent, volatile))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, wireEvent.type, error));
    const legacy = legacyTaskEvent(event, agentId, sessionId);
    if (legacy !== undefined) {
      state.queue = state.queue
        .then(() => this.dispatch(state, legacy, volatile))
        .catch((error: unknown) => this.logDispatchDropped(state.sessionId, legacy.type, error));
    }
  }

  /**
   * Bridge the session's interaction kernel (approvals / questions) onto the
   * v1 event stream. The kernel only emits in-process notifications
   * (`onDidChangePending` / `onDidResolve`), so the v1 protocol events are
   * synthesized here.
   */
  private attachInteractions(
    sessionId: string,
    session: ISessionScopeHandle,
    state: SessionState,
  ): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    for (const i of listSessionPendingInteractions(agents)) {
      state.knownInteractions.set(i.id, { kind: i.kind, agentId: i.origin.agentId ?? 'main' });
    }
    state.lifecycleDisposables.push(
      onSessionInteractionDidChangePending(agents, () => {
        for (const i of listSessionPendingInteractions(agents)) {
          if (state.knownInteractions.has(i.id)) continue;
          state.knownInteractions.set(i.id, {
            kind: i.kind,
            agentId: i.origin.agentId ?? 'main',
          });
          const event = interactionRequestedEvent(i, sessionId);
          if (event !== undefined) {
            this.enqueueDurable(state, event);
          }
        }
      }),
      onSessionInteractionDidResolve(agents, ({ id, response }) => {
        const known = state.knownInteractions.get(id);
        if (known === undefined) return;
        state.knownInteractions.delete(id);
        const event = interactionResolvedEvent(known.kind, id, response, sessionId, known.agentId);
        if (event !== undefined) {
          this.enqueueDurable(state, event);
        }
      }),
    );
  }

  private enqueueDurable(state: SessionState, event: Event): void {
    state.queue = state.queue
      .then(() => this.dispatch(state, event, false))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  /**
   * Emit `event.session.work_changed` for one aggregate change announced by
   * the core `ISessionActivityView` (the view already dedups — every call
   * here is a real tuple change).
   */
  private enqueueWorkChanged(state: SessionState, work: SessionActivityState): void {
    state.queue = state.queue
      .then(() =>
        this.dispatch(
          state,
          {
            type: 'event.session.work_changed',
            busy: work.busy,
            main_turn_active: work.mainTurnActive,
            pending_interaction: work.pendingInteraction,
            last_turn_reason: work.lastTurnReason,
            agentId: 'main',
            sessionId: state.sessionId,
          } as Event,
          false,
        ),
      )
      .catch((error: unknown) =>
        this.logDispatchDropped(state.sessionId, 'event.session.work_changed', error),
      );
  }

  /**
   * Log a rejected `dispatchSessionEvent` promise — the session's scope was
   * torn down mid-dispatch, or a non-disposed error escaped `ensureState`.
   */
  private logDispatchError(sessionId: string, eventType: string, error: unknown): void {
    const logger = this.opts.logger;
    if (logger === undefined) return;
    if (logger.error !== undefined) {
      logger.error({ sessionId, eventType, err: error }, 'session event dispatch failed');
    } else {
      logger.warn({ sessionId, eventType, err: error }, 'session event dispatch failed');
    }
  }

  /**
   * A queued dispatch rejected: the event is permanently lost (and, for durable
   * events, the seq is skipped). Warn instead of swallowing it silently.
   */
  private logDispatchDropped(sessionId: string, eventType: string, error: unknown): void {
    this.opts.logger?.warn(
      { sessionId, eventType, err: error },
      'session event dispatch failed; event dropped',
    );
  }

  private async dispatch(state: SessionState, event: Event, volatile: boolean): Promise<void> {
    const { journal, tracker, roster, tail, targets, sessionId } = state;
    const annotation = tracker.apply(sessionId, event);
    roster.apply(sessionId, event);

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
      const recipients = new Set<BroadcastTarget>(this.globalTargets);
      for (const target of this.allTargets()) recipients.add(target);
      const diGated = event.type.startsWith('event.di.');
      for (const target of recipients) {
        if (diGated && !this.diEventTargets.has(target)) continue;
        try {
          target.send(envelope, 'immediate');
        } catch {
        }
      }
    } else {
      for (const [target, sub] of targets) {
        if (!matchesAgentFilter(envelope, sub.agentFilter)) continue;
        if (suppressedByTranscript(envelope, sub.transcriptGrades)) continue;
        try {
          target.send(envelope);
        } catch {
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
      timestamp:
        event.time !== undefined
          ? new Date(event.time).toISOString()
          : new Date().toISOString(),
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

const VOLATILE_SIGNAL_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(VOLATILE_SIGNAL_TYPES);

function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

function legacyTaskEvent(event: Event2<any>, agentId: string, sessionId: string): Event | undefined {
  if (event.type !== 'task.started' && event.type !== 'task.terminated') return undefined;
  const legacyType =
    event.type === 'task.started' ? 'background.task.started' : 'background.task.terminated';
  return Object.assign({}, event, { type: legacyType, agentId, sessionId }) as unknown as Event;
}

function isGlobalEvent(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.') ||
    type.startsWith('event.plugin.') ||
    type.startsWith('event.capability.') ||
    type.startsWith('event.di.')
  );
}

function isAgentLifecycleEvent(type: string): boolean {
  return type === 'agent.created' || type === 'agent.disposed';
}

function matchesAgentFilter(envelope: EventEnvelope, filter: AgentFilter): boolean {
  if (filter === undefined) return true;
  if (isGlobalEvent(envelope.type)) return true;
  if (isAgentLifecycleEvent(envelope.type)) return true;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return true;
  return filter.has(agentId);
}

const TRANSCRIPT_PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.interrupted',
  'turn.step.retrying',
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.call.started',
  'tool.progress',
  'tool.result',
  'shell.started',
  'shell.output',
  'shell.completed',
  'task.started',
  'task.terminated',
  'background.task.started',
  'background.task.terminated',
  'task.notified',
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.suspended',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'skill.activated',
  'plugin_command.activated',
  'cron.fired',
  'error',
  'warning',
  'goal.updated',
  'plan.revision',
  'context.spliced',
  'agent.status.updated',
  'hook.result',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'event.question.requested',
  'event.question.dismissed',
  'event.question.answered',
  'event.approval.requested',
  'event.approval.resolved',
]);

function suppressedByTranscript(
  envelope: EventEnvelope,
  spec: TranscriptGradeSpec | undefined,
): boolean {
  if (spec === undefined) return false;
  if (isGlobalEvent(envelope.type)) return false;
  if (isAgentLifecycleEvent(envelope.type)) return false;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return false;
  if (gradeFor(spec, agentId) === 'off') return false;
  return TRANSCRIPT_PROJECTED_EVENT_TYPES.has(envelope.type);
}

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
      return undefined;
  }
}

function interactionResolvedEvent(
  kind: InteractionKind,
  id: string,
  response: unknown,
  sessionId: string,
  agentId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case 'question': {
      if (response === null) {
        return {
          type: 'event.question.dismissed',
          agentId,
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      const answers = (response as { answers?: unknown }).answers ?? response;
      return {
        type: 'event.question.answered',
        agentId,
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
        agentId,
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
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
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
