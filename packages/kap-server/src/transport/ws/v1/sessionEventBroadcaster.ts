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
 *      broadcast (see step 3). The same lifecycle callbacks fan durable
 *      `agent.created` / `agent.disposed` facts out at session granularity
 *      (they bypass per-subscription agent allowlists but never leave the
 *      session). Also subscribes to the session's
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
 *
 * Transcript dedup: a connection subscribed to the transcript protocol
 * (grade ≠ 'off' for the emitting agent) no longer receives the
 * `session_event`s the transcript already projects — see
 * {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}. Suppression is a per-connection
 * send-view crop only: the journal and tail keep recording every event, and
 * connections without a transcript spec are unaffected.
 */

import type {
  AgentActivityState,
  ApprovalResponse,
  DomainEvent,
  GlobalEvent,
  IAgentScopeHandle,
  IDisposable,
  Interaction,
  InteractionKind,
  ISessionScopeHandle,
  Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IAgentActivityView,
  IEventBus,
  IEventService,
  ISessionInteractionService,
  ISessionIndex,
  ISessionLifecycleService,
  MAIN_AGENT_ID,
} from '@moonshot-ai/agent-core-v2';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { SessionCreatedEvent, SessionMetaUpdatedEvent, Event } from './events';
import { isVolatileEventType } from './events';
import type { SessionCursor } from '../../../protocol/ws-control';
import type { InFlightTurn, SnapshotSubagent } from '../../../protocol/rest-snapshot';
import type { SessionPendingInteraction } from '../../../protocol/session';
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

import { toWireApproval } from '../../../routes/approvals';
import { toWireQuestion } from '../../../routes/questions';
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

/**
 * What one connection wants from a session: the legacy agent allowlist plus
 * the opt-in per-agent transcript grades (`Record<agentId|'*', grade>`; absent
 * = all 'off' — legacy clients see no transcript frames at all).
 */
export interface TargetSubscription {
  readonly agentFilter?: AgentFilter;
  readonly transcriptGrades?: TranscriptGradeSpec;
}

/** Per-session transcript streaming state (shared across all targets). */
interface TranscriptStream {
  /** The store this stream's listeners are attached to — a rebuilt store (session reload) forces re-attachment. */
  readonly store: TranscriptStore;
  /** Agents already seeded (roster de-dup for the reset fan-out). */
  readonly knownAgents: Set<string>;
}

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly roster: SubagentRosterTracker;
  /**
   * Per-agent fold of `agent.activity.updated` — the only input to the
   * session's `work_changed` fact: `busy` = any agent with an active turn or
   * background task, `last_turn_reason` = the main agent's latest outcome
   * (`blocked` folds into `failed`). Session level stores nothing of its own;
   * this map is a pure, discardable aggregate of agent-level state. Seeded
   * once from the live views at activation.
   */
  readonly activityByAgent: Map<string, AgentWorkFold>;
  /** Last emitted work-fact tuple, for dedup. */
  emittedBusy: boolean;
  emittedMainTurnActive: boolean;
  emittedPendingInteraction: SessionPendingInteraction;
  emittedTurnOutcome?: 'completed' | 'cancelled' | 'failed';
  pendingInteraction: SessionPendingInteraction;
  /** Recent durable envelopes for in-memory replay. */
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Connections subscribed to this session, each with its subscription view. */
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  /** Per-session dispatch queue — serializes stamp / journal / fan-out. */
  queue: Promise<void>;
  /** agentId → sink subscription. */
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
  /** Interactions already announced (or pre-existing at activation): id → kind + owning agent (for the resolved event). */
  readonly knownInteractions: Map<string, { readonly kind: InteractionKind; readonly agentId: string }>;
  /** Attached on first transcript-grade subscription for this session. */
  transcriptStream?: TranscriptStream;
  /** Connections whose transcript baseline reset has landed — the ops fan-out is gated on it. */
  readonly transcriptSeeded: Set<BroadcastTarget>;
  /** Resets deferred until the connection's cursor replay completes (ordering: backlog before baseline). */
  readonly deferredTranscriptSeeds: Map<
    BroadcastTarget,
    { readonly spec: TranscriptGradeSpec; readonly transcriptSince?: Record<string, number> }
  >;
}

/** The aggregate-relevant slice of one agent's activity state. */
interface AgentWorkFold {
  turnActive: boolean;
  background: number;
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
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
      /**
       * Optional transcript owner; when present, `subscribe` with transcript
       * grades activates per-agent op streaming for live sessions. Absent =
       * transcript disabled (tests / minimal embeds).
       */
      readonly transcriptService?: TranscriptService;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.coreEventSubscription = opts.core.accessor
      .get(IEventService)
      .subscribe((event) => this.onCoreEvent(event));
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
        // The baseline rides `flushTranscriptSeed` (after the caller's cursor
        // replay), so the reset's seq always follows the replayed backlog.
        state.transcriptSeeded.delete(target);
        state.deferredTranscriptSeeds.set(target, {
          spec: transcriptGrades,
          transcriptSince: opts.transcriptSince,
        });
      } else {
        state.deferredTranscriptSeeds.delete(target);
        // Gate the ops fan-out only while a replacement baseline is actually
        // on its way — a no-reset resubscribe must not black out the stream.
        const gated = this.willSendTranscriptReset(state, target, transcriptGrades, prev);
        if (gated) state.transcriptSeeded.delete(target);
        await this.subscribeTranscript(
          state,
          target,
          transcriptGrades,
          prev?.transcriptGrades,
          prev?.agentFilter,
          opts?.transcriptSince,
        );
        // A no-reset subscription owes no baseline — the target is seeded
        // either way (a fresh session with an empty roster must still
        // receive roster resets and ops once agents appear).
        if (state.targets.has(target)) state.transcriptSeeded.add(target);
      }
    }
    return true;
  }

  /**
   * Whether `subscribeTranscript` will send at least one reset for this
   * (target, spec) pair right now — an upgrade over the previous grades or an
   * agent newly admitted by a widened legacy filter.
   */
  private willSendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TargetSubscription | undefined,
  ): boolean {
    const service = this.opts.transcriptService;
    if (service === undefined) return false;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return false;
    const agentFilter = state.targets.get(target)?.agentFilter;
    for (const descriptor of store.agents()) {
      if (agentFilter !== undefined && !agentFilter.has(descriptor.agentId)) continue;
      const grade = gradeFor(spec, descriptor.agentId);
      if (grade === 'off') continue;
      if (needsResetOnTransition(gradeFor(prev?.transcriptGrades, descriptor.agentId), grade)) {
        return true;
      }
      if (prev?.agentFilter !== undefined && !prev.agentFilter.has(descriptor.agentId)) return true;
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
    await this.subscribeTranscript(state, target, deferred.spec, undefined, undefined, deferred.transcriptSince);
    if (state.targets.has(target)) state.transcriptSeeded.add(target);
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    state.targets.delete(target);
    state.transcriptSeeded.delete(target);
    state.deferredTranscriptSeeds.delete(target);
  }

  // ---------------------------------------------------------------------------
  // Transcript streaming (v1 incremental add-on; the durable event path is
  // untouched — transcript frames never advance seq and never touch the journal)
  // ---------------------------------------------------------------------------

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
   * baseline is silently skipped. Grades and the filter are re-read from
   * `state.targets` after the awaits: subscribe work runs asynchronously, and
   * a newer subscribe/unsubscribe must not be answered with stale resets.
   */
  private async subscribeTranscript(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
    prevFilter?: AgentFilter,
    transcriptSince?: Record<string, number>,
  ): Promise<void> {
    const service = this.opts.transcriptService;
    if (service === undefined) return;
    const store = service.forSessionLive(state.sessionId);
    if (store === undefined) return;
    await service.whenReady(state.sessionId);
    const backfillFilter = state.targets.get(target)?.agentFilter;
    const backfill = new Set(
      Object.keys(spec).filter((agentId) => agentId !== '*' && gradeFor(spec, agentId) !== 'off'),
    );
    for (const descriptor of store.agents()) {
      if (backfillFilter !== undefined && !backfillFilter.has(descriptor.agentId)) continue;
      if (gradeFor(spec, descriptor.agentId) !== 'off') backfill.add(descriptor.agentId);
    }
    await Promise.all(
      [...backfill].map((agentId) => service.ensureAgentHistory(state.sessionId, agentId)),
    );
    // A newer subscribe/unsubscribe may have replaced this target's grades
    // while history was loading — only the latest subscription is owed resets.
    const current = state.targets.get(target);
    if (current?.transcriptGrades === undefined) return;
    const currentSpec = current.transcriptGrades;
    this.ensureTranscriptStream(state, store);
    // The legacy agent allowlist composes with transcript grades: a
    // connection filtered to a subset never receives other agents'
    // transcript frames, whatever the grades admit.
    const agentFilter = current.agentFilter;
    for (const descriptor of store.agents()) {
      if (agentFilter !== undefined && !agentFilter.has(descriptor.agentId)) continue;
      const grade = gradeFor(currentSpec, descriptor.agentId);
      if (grade === 'off') continue;
      const transcript = store.getAgent(descriptor.agentId);
      if (transcript === undefined) continue;
      // A catch-up cursor the journal still covers replaces the baseline
      // reset: replay exactly the batches past the cursor (grade-filtered, in
      // seq order) and the connection converges without a snapshot. Anything
      // the journal cannot vouch for falls through to the ordinary reset.
      const since = transcriptSince?.[descriptor.agentId] ?? transcriptSince?.['*'];
      if (since !== undefined) {
        const catchup = service.getOpsSince(state.sessionId, descriptor.agentId, since);
        if (catchup !== undefined && catchup.complete) {
          this.replayTranscriptOps(state, target, descriptor.agentId, grade, catchup.batches);
          continue;
        }
      }
      // A broadened legacy filter admits agents the grade transition alone
      // would skip (delta → delta) — having suppressed their ops so far, it
      // owes them a baseline now.
      const admittedByWiderFilter =
        prevFilter !== undefined && !prevFilter.has(descriptor.agentId);
      if (
        !needsResetOnTransition(gradeFor(prev, descriptor.agentId), grade) &&
        !admittedByWiderFilter
      ) {
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
        // best-effort fan-out; a broken target is dropped, not fatal
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
        // No ops before the baseline reset (see subscribe).
        if (!state.transcriptSeeded.has(target)) continue;
        // The legacy agent allowlist gates transcript frames too.
        if (sub.agentFilter !== undefined && !sub.agentFilter.has(agentId)) continue;
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
          // best-effort fan-out; a broken target is dropped, not fatal
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
            if (sub.agentFilter !== undefined && !sub.agentFilter.has(descriptor.agentId)) continue;
            const grade = gradeFor(sub.transcriptGrades, descriptor.agentId);
            if (grade === 'off') continue;
            try {
              this.sendTranscriptReset(state, target, transcript, grade);
            } catch {
              // best-effort fan-out; a broken target is dropped, not fatal
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
        // Watermark: the snapshot includes every op batch dispatched so far.
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
    // envelopes are narrowed to the subscriber's agent allowlist — and, for a
    // transcript subscriber, stripped of the events the transcript already
    // projects. The journal itself keeps every event, so re-subscribing
    // without a transcript spec replays the complete history.
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
      // Transcript bindings die with the session stream (its store
      // subscriptions were disposed above; the producer binding goes here).
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
    const activityByAgent = new Map<string, AgentWorkFold>();
    for (const handle of session.accessor.get(IAgentLifecycleService).list()) {
      activityByAgent.set(handle.id, readAgentWorkFold(handle));
    }
    const pendingInteraction = resolvePendingInteraction(
      session.accessor.get(ISessionInteractionService).listPending(),
    );
    const state: SessionState = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      roster: new SubagentRosterTracker(),
      activityByAgent,
      emittedBusy: aggregateBusy(activityByAgent),
      emittedMainTurnActive: activityByAgent.get(MAIN_AGENT_ID)?.turnActive ?? false,
      emittedPendingInteraction: pendingInteraction,
      emittedTurnOutcome: activityByAgent.get(MAIN_AGENT_ID)?.lastTurnReason,
      pendingInteraction,
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
      activityByAgent: new Map(),
      emittedBusy: false,
      emittedMainTurnActive: false,
      emittedPendingInteraction: 'none',
      pendingInteraction: 'none',
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

  private onCoreEvent(event: GlobalEvent): void {
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
      } as Event).catch((error: unknown) =>
        this.logDispatchError(payload.sessionId, 'event.session.created', error),
      );
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
      } as Event).catch((error: unknown) =>
        this.logDispatchError(sessionId, 'session.meta.updated', error),
      );
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
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, event.type, error));
  }

  private attachAgents(sessionId: string, session: ISessionScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IAgentScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      if (!state.activityByAgent.has(handle.id)) {
        state.activityByAgent.set(handle.id, readAgentWorkFold(handle));
        this.enqueueWorkChanged(state);
      }
      state.agentDisposables.set(handle.id, this.attachAgent(sessionId, handle));
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => {
        subscribeAgent(handle);
        // Session-grained lifecycle fact, ahead of any of the agent's own
        // events: `onDidCreate` fires before the agent's eager services
        // ignite, so this enqueue lands first in the queue.
        this.enqueueDurable(state, {
          type: 'agent.created',
          agentId: handle.id,
          sessionId,
        });
      }),
      agents.onDidDispose((agentId) => {
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
        // A removed agent can no longer contribute work; drop its fold and
        // re-evaluate the aggregate (its turn.ended normally lands first, but
        // the delete keeps the map honest either way).
        if (state.activityByAgent.delete(agentId)) this.enqueueWorkChanged(state);
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
      });
    };
    const disposables: IDisposable[] = [
      eventBus.subscribe((event) => {
        let projected = event;
        if (handle.id === MAIN_AGENT_ID && event.type === 'agent.status.updated') {
          const snapshot = readLegacyStatus(handle);
          if (snapshot !== undefined) {
            lastLegacyStatus = JSON.stringify(snapshot);
            projected = { ...event, ...snapshot };
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

  private onAgentEvent(sessionId: string, agentId: string, event: DomainEvent): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;

    // Map the native v2 activity state to the legacy v1 `agent.status.updated`
    // phase slice at the edge, so the v1 channel picks up the corrected
    // semantics (approval-set, idle-after-ended) without the core engine
    // carrying v1 compatibility. The core's own `agent.status.updated` phase
    // slice is dropped here to avoid duplicate phase events; other slices
    // (usage / context / plan / swarm) flow through unchanged. The same event
    // also feeds the session's work-fold aggregate (busy / last_turn_reason).
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
      // Fold into the aggregate. A turnActive flip always rides a
      // turn.started/turn.ended boundary that fires right after this event
      // (the view publishes synchronously inside it), so emission is left to
      // that trigger to keep the busy:true-before / busy:false-after frame
      // order. Everything else (background tasks, agent teardown) emits here.
      const previous = state.activityByAgent.get(agentId);
      const next = {
        turnActive: snapshot.turn !== undefined,
        background: snapshot.background?.length ?? 0,
        lastTurnReason:
          agentId === MAIN_AGENT_ID
            ? mapTurnReason(snapshot.lastTurn?.reason)
            : previous?.lastTurnReason,
      };
      state.activityByAgent.set(agentId, next);
      if (
        previous !== undefined &&
        previous.turnActive === next.turnActive &&
        (previous.background !== next.background ||
          (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason))
      ) {
        this.enqueueWorkChanged(state);
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
    // Turn boundaries are the emission TRIGGERS for `work_changed` (ordering:
    // busy:true lands before the turn.started frame, busy:false after the
    // turn.ended frame). The payload is computed from the per-agent fold —
    // the view's activity update for this same boundary has already been
    // folded in (it publishes synchronously inside the boundary dispatch,
    // ahead of this handler). Every agent triggers: busy counts all agents'
    // turns and background tasks; only the main agent feeds last_turn_reason.
    if (event.type === 'turn.started') {
      this.enqueueWorkChanged(state);
    }
    const volatile = isVolatileSignal(event.type);
    state.queue = state.queue
      .then(() => this.dispatch(state, wireEvent, volatile))
      .catch((error: unknown) => this.logDispatchDropped(state.sessionId, wireEvent.type, error));
    if (event.type === 'turn.ended') {
      // Emit completion after the turn event.
      this.enqueueWorkChanged(state);
    }
    // v1 wire compat: fan the legacy `background.task.*` spelling out next to
    // the native `task.*` event (see `legacyTaskEvent`) so unchanged v1 clients
    // keep working while v2-shaped clients ignore the alias. Same volatility as
    // the native event so replay/journal/filter stay coherent between the two.
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
    const interactions = session.accessor.get(ISessionInteractionService);
    // Seed silently: interactions already pending at activation are surfaced
    // by the snapshot route (`pending_questions` / `pending_approvals`).
    for (const i of interactions.listPending()) {
      state.knownInteractions.set(i.id, { kind: i.kind, agentId: i.origin.agentId ?? 'main' });
    }
    state.lifecycleDisposables.push(
      interactions.onDidChangePending(() => {
        const pending = interactions.listPending();
        state.pendingInteraction = resolvePendingInteraction(pending);
        this.enqueueWorkChanged(state);
        for (const i of pending) {
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
      interactions.onDidResolve(({ id, response }) => {
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
   * Emit `event.session.work_changed` when its orthogonal work-fact tuple
   * actually changed. Activity facts come from the per-agent fold and pending
   * interaction facts come from the session interaction kernel.
   */
  private enqueueWorkChanged(state: SessionState): void {
    state.queue = state.queue
      .then(async () => {
        const busy = aggregateBusy(state.activityByAgent);
        const mainTurnActive = state.activityByAgent.get(MAIN_AGENT_ID)?.turnActive ?? false;
        const outcome = state.activityByAgent.get(MAIN_AGENT_ID)?.lastTurnReason;
        if (
          busy === state.emittedBusy &&
          mainTurnActive === state.emittedMainTurnActive &&
          state.pendingInteraction === state.emittedPendingInteraction &&
          outcome === state.emittedTurnOutcome
        ) {
          return;
        }
        state.emittedBusy = busy;
        state.emittedMainTurnActive = mainTurnActive;
        state.emittedPendingInteraction = state.pendingInteraction;
        state.emittedTurnOutcome = outcome;
        await this.dispatch(
          state,
          {
            type: 'event.session.work_changed',
            busy,
            main_turn_active: mainTurnActive,
            pending_interaction: state.pendingInteraction,
            last_turn_reason: outcome,
            agentId: 'main',
            sessionId: state.sessionId,
          } as Event,
          false,
        );
      })
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
    // Same queue-discipline as the in-flight tracker: snapshot rebuilds must
    // see exactly the roster as of the durable watermark.
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
      // Global events (session/workspace/config) are not agent
      // events — fan out to every subscriber regardless of any agent filter.
      for (const target of this.allTargets()) {
        try {
          target.send(envelope);
        } catch {
          // best-effort fan-out; a broken target is dropped, not fatal
        }
      }
    } else {
      for (const [target, sub] of targets) {
        if (!matchesAgentFilter(envelope, sub.agentFilter)) continue;
        // Transcript subscribers already receive the projected equivalent of
        // this event — drop the duplicate session_event on their send view.
        if (suppressedByTranscript(envelope, sub.transcriptGrades)) continue;
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
  'shell.completed',
  'agent.status.updated',
] as const;

const volatileSignalTypeSet: ReadonlySet<string> = new Set(VOLATILE_SIGNAL_TYPES);

function isVolatileSignal(type: string): boolean {
  return volatileSignalTypeSet.has(type);
}

/**
 * Fold one agent's live activity view into the aggregate slice. Defensive:
 * a missing view (never ignited) folds to not-busy.
 */
function readAgentWorkFold(handle: IAgentScopeHandle): AgentWorkFold {
  const view = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
  const state = view?.state();
  return {
    turnActive: state?.turn !== undefined,
    background: state?.background.length ?? 0,
    lastTurnReason: mapTurnReason(state?.lastTurn?.reason),
  };
}

function mapTurnReason(
  reason: TurnEndReason | undefined,
): 'completed' | 'cancelled' | 'failed' | undefined {
  if (reason === undefined) return undefined;
  return reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
}

/** `busy` = any agent has an active turn or live background tasks. */
function aggregateBusy(map: ReadonlyMap<string, AgentWorkFold>): boolean {
  for (const fold of map.values()) {
    if (fold.turnActive || fold.background > 0) return true;
  }
  return false;
}

function resolvePendingInteraction(
  pending: readonly Interaction[],
): SessionPendingInteraction {
  if (pending.some((interaction) => interaction.kind === 'approval')) return 'approval';
  if (pending.some((interaction) => interaction.kind === 'question')) return 'question';
  return 'none';
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

/** Session/workspace/config events are broadcast to every connection. */
function isGlobalEvent(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.')
  );
}

function isAgentLifecycleEvent(type: string): boolean {
  return type === 'agent.created' || type === 'agent.disposed';
}

/**
 * Per-subscription agent allowlist check — shared by live fan-out and replay.
 * Returns `true` when the envelope should be delivered to a subscriber carrying
 * `filter`:
 *   - `filter === undefined` → receive every agent (legacy session-grained
 *     behavior);
 *   - global events (session/workspace/config) and agent lifecycle events
 *     (`agent.created` / `agent.disposed`) are not per-agent stream content
 *     and always pass;
 *   - events without a string `agentId` (should not happen on the v1 wire,
 *     where the broadcaster stamps every event) pass defensively rather than
 *     being dropped;
 *   - otherwise the envelope's `payload.agentId` must be in the allowlist.
 */
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

/**
 * Event types the transcript protocol already projects (the authoritative
 * mapping is the projector — `services/transcript/coreEventMap.ts`): a
 * connection carrying a non-'off' transcript grade for the emitting agent
 * gets the same information via `transcript.ops` / `transcript.reset`, so the
 * duplicate `session_event` is suppressed on that connection.
 *
 * Deliberately retained (never suppressed):
 *   - `agent.created` / `agent.disposed` — the transcript has no lifecycle
 *     events; a roster change surfaces there only implicitly, as the new
 *     agent's baseline reset;
 *   - `tool.list.updated`, `mcp.server.status` — not projected;
 *   - every global event ({@link isGlobalEvent}) — session/workspace/config
 *     facts live outside the per-agent transcript.
 *
 * Two entries are defensive: `prompt.submitted` is projected but nobody
 * publishes it on the v2 bus today (Phase 2 finding), and `task.notified` has
 * a projector case without a v1 wire-schema entry. `background.task.started`
 * / `background.task.terminated` are the legacy aliases of the projected
 * `task.started` / `task.terminated` (see {@link legacyTaskEvent}).
 */
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

/**
 * Per-connection transcript dedup check — shared by live fan-out and replay,
 * mirroring {@link matchesAgentFilter}. Returns `true` when the envelope is a
 * transcript-projected `session_event` the subscriber already receives via
 * the transcript stream:
 *   - `spec === undefined` → nothing is suppressed (legacy connections see
 *     every `session_event`);
 *   - global events and agent lifecycle events are never suppressed;
 *   - events without a string `agentId` pass defensively (same rule as the
 *     agent allowlist);
 *   - an 'off' grade for the emitting agent suppresses nothing;
 *   - otherwise the envelope is suppressed iff its type is in
 *     {@link TRANSCRIPT_PROJECTED_EVENT_TYPES}.
 */
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
  agentId: string,
): Event | undefined {
  const resolvedAt = new Date().toISOString();
  switch (kind) {
    case 'question': {
      // `null` marks a dismissal (see `ISessionQuestionService.dismiss`).
      if (response === null) {
        return {
          type: 'event.question.dismissed',
          agentId,
          sessionId,
          question_id: id,
          dismissed_at: resolvedAt,
        } as unknown as Event;
      }
      // `QuestionResult` is either `{ answers, method? }` or a bare answers record.
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
