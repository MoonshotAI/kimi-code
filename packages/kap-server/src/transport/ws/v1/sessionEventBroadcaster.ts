/**
 * `SessionEventBroadcaster` — per-session single fan-out point that turns
 * engine events into a sequenced `/api/v1/ws` event stream (the
 * `{seq, epoch}` watermark) with replay and snapshot support.
 *
 * Port of v1's `WSBroadcastService` (`packages/server/.../wsBroadcastService.ts`).
 * The Rust engine is the only engine, so there is no v2 event bus and no DI
 * scope: sessions live in the engine, which owns the event stream and feeds
 * this edge via {@link SessionEventBroadcaster.broadcastRustFrame}. A
 * subscription activates an ephemeral in-memory session state (journal is
 * `:memory:` — never written) that:
 *
 *   1. Stamps engine frames with the session's current durable watermark as
 *      `seq` and `volatile: true` (never journaled, never replayed).
 *   2. Fans them out to every target subscribed to the session plus every
 *      global target (registered via
 *      {@link SessionEventBroadcaster.addGlobalTarget}).
 *   3. Tracks per-target transcript grades (seeded / deferred baseline
 *      bookkeeping) while live transcript streaming is a no-op — the engine
 *      owns the transcript store and serves it over REST.
 *
 * A session is activated on first `subscribe` / `getSnapshotState` /
 * `getCursor` and stays active for the process lifetime. The journal and
 * replay machinery (`getBufferedSince`) is retained with its cursor
 * semantics; in engine mode nothing journalable is ever dispatched, so
 * replay serves the empty sequence and frames stay volatile.
 */

import type { SessionCursor } from '../../../protocol/ws-control';
import type { InFlightTurn, SnapshotSubagent } from '../../../protocol/rest-snapshot';
import {
  detachGrades,
  gradeFor,
  type TranscriptGradeSpec,
} from '@moonshot-ai/transcript';

import { InFlightTurnTracker } from './inFlightTurnTracker';
import { SubagentRosterTracker } from './subagentRosterTracker';
import {
  type EventEnvelope,
  type JournalLogger,
  SessionEventJournal,
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

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly roster: SubagentRosterTracker;
  /** Recent durable envelopes for in-memory replay. */
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Connections subscribed to this session, each with its subscription view. */
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  /** Per-session dispatch queue — serializes stamp / journal / fan-out. */
  queue: Promise<void>;
  /** Connections whose transcript baseline reset has landed — the ops fan-out is gated on it. */
  readonly transcriptSeeded: Set<BroadcastTarget>;
  /** Resets deferred until the connection's cursor replay completes (ordering: backlog before baseline). */
  readonly deferredTranscriptSeeds: Map<
    BroadcastTarget,
    { readonly spec: TranscriptGradeSpec; readonly transcriptSince?: Record<string, number> }
  >;
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;

async function disposeSessionState(state: SessionState): Promise<void> {
  await state.journal.close();
}

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  /**
   * Every established connection, subscribed or not. Engine frames fan out
   * to this set (union the per-session targets) so a freshly connected
   * client sees session-level facts without subscribing to anything.
   */
  private readonly globalTargets = new Set<BroadcastTarget>();
  /**
   * Single-flight guard for session activation: without it, two concurrent
   * activations (WS subscribe racing a REST snapshot / replay / resync)
   * would each build their own SessionState and journal writer, duplicating
   * state and envelopes for the same session.
   */
  private readonly pendingStates = new Map<string, Promise<SessionState | undefined>>();
  private readonly maxBufferSize: number;
  private readonly rustOnly: boolean;
  private closed = false;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      /**
       * Legacy v2 DI scope — accepted for `start.ts` / test compatibility
       * only; engine-only mode ignores it (sessions and events are owned by
       * the Rust engine, not the v2 DI scope).
       */
      readonly core?: unknown;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
      /**
       * Legacy transcript owner — accepted for `start.ts` / test compatibility
       * only; engine-only mode ignores it (live transcript streaming is a
       * no-op; the engine owns the transcript store and serves it over REST).
       */
      readonly transcriptService?: unknown;
      /** Engine-only mode: serve subscriptions with ephemeral in-memory
       *  session states (Rust engine frames arrive via `broadcastRustFrame`). */
      readonly rustOnly?: boolean;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.rustOnly = opts.rustOnly ?? false;
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
  }

  /**
   * Fan out a Rust-engine projected v1 frame to a session's subscribers.
   *
   * Rust-engine sessions (`RustSessionService`) produce their own event
   * stream, so their frames arrive here directly instead of riding an agent
   * event-bus journal path. The frame is wrapped in a volatile envelope
   * stamped with the session's current durable watermark (never advancing
   * `seq`) and sent to every target subscribed to the session plus every
   * global target.
   *
   * A session with no live subscribers is a no-op — the REST surface
   * (`session/prompt` etc.) still works, only the live push is skipped.
   */
  broadcastRustFrame(sessionId: string, frame: Record<string, unknown>): void {
    const state = this.sessions.get(sessionId);
    const envelope: EventEnvelope = {
      type: 'event',
      seq: state?.journal.seq ?? 0,
      epoch: state?.journal.epoch,
      volatile: true,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: frame,
    };
    if (state !== undefined) {
      for (const target of state.targets.keys()) {
        target.send(envelope);
      }
    }
    for (const target of this.globalTargets) {
      target.send(envelope);
    }
  }

  /**
   * Subscribe a connection to a session's stream (activates the session).
   *
   * When `transcriptGrades` is present the connection also joins the
   * session's transcript bookkeeping (seeded / deferred baseline tracking);
   * live transcript streaming is a no-op in engine mode — the engine owns
   * the transcript store and serves it over REST.
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
        await this.subscribeTranscript(
          state,
          target,
          transcriptGrades,
          prev?.transcriptGrades,
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
   * Flush the transcript baseline deferred by `subscribe(deferTranscriptReset)`
   * — callers run it after their cursor replay so the reset's seq always
   * follows the replayed backlog. Engine mode applies the seeded / deferred
   * bookkeeping; the live store stream itself is a no-op.
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
   * Non-activating and idempotent: unknown sessions/targets are no-ops. When
   * no non-'off' grade remains the spec collapses to `undefined` and the
   * seeded/deferred baselines are dropped.
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
   * Handle one connection's transcript subscription. Engine-only mode: the
   * live store stream is a no-op — the Rust engine owns the transcript store
   * and serves it over REST, and there is no in-process ops fan-out to
   * attach. The method is retained with its signature so the `subscribe` /
   * `flushTranscriptSeed` protocol shape — seeded / deferred baseline
   * bookkeeping — is unchanged.
   */
  private async subscribeTranscript(
    _state: SessionState,
    _target: BroadcastTarget,
    _spec: TranscriptGradeSpec,
    _prev: TranscriptGradeSpec | undefined,
    _transcriptSince?: Record<string, number>,
  ): Promise<void> {
    // Engine-only mode: no-op (see above).
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
      return { seq: 0, epoch: '' };
    }
    await state.queue;
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  /** Atomic-at-queue watermark + in-flight turn, for the snapshot route. */
  async getSnapshotState(sessionId: string): Promise<SessionSnapshotState> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { seq: 0, epoch: '', inFlightTurn: null, subagents: [] };
    }
    await state.queue;
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      inFlightTurn: state.tracker.get(sessionId),
      subagents: state.roster.get(sessionId),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.sessions.values()) {
      await disposeSessionState(state);
    }
    this.sessions.clear();
  }

  private ensureState(sessionId: string): Promise<SessionState | undefined> {
    if (this.closed) return Promise.resolve();
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

    if (this.rustOnly) {
      // Engine mode: sessions live in the engine, not a JS-side lifecycle. A
      // subscription creates an in-memory state — journal is ephemeral
      // (`:memory:` — never written) and carries no event/agent attachments;
      // Rust engine frames arrive via `broadcastRustFrame`.
      const journal = await SessionEventJournal.open(':memory:', this.opts.logger);
      const state: SessionState = {
        sessionId,
        journal,
        tracker: new InFlightTurnTracker(),
        roster: new SubagentRosterTracker(),
        tail: [],
        targets: new Map(),
        queue: Promise.resolve(),
        transcriptSeeded: new Set(),
        deferredTranscriptSeeds: new Map(),
      };
      this.sessions.set(sessionId, state);
      return state;
    }

    // The v2 lifecycle path was removed — the Rust engine is the only engine.
    return undefined;
  }
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
 * publishes it today (Phase 2 finding), and `task.notified` has a projector
 * case without a v1 wire-schema entry. `background.task.started` /
 * `background.task.terminated` are the legacy aliases of the projected
 * `task.started` / `task.terminated`.
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
