import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  IAgentLifecycleService,
  ISessionIndex,
  ISessionMetadata,
  IAgentLoopService,
  followSessionLifecycles,
  getLiveSessionById,
  reduceContextTranscript,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';
import {
  TranscriptStore,
  foldWireRecordFacts,
  groupMessagesIntoSnapshot,
  isPlainAgentId,
  type AgentDescriptor,
  type AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import { readWireRecords } from './wireRecords';
import {
  bindSessionTranscript,
  descriptorFromMeta,
  type TranscriptBinding,
  type TranscriptBindingLogger,
} from './coreBinding';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const MAIN_AGENT_ID = 'main';
const WIRE_FILE = 'wire.jsonl';
const STATE_FILE = 'state.json';

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  readonly ready: Promise<void>;
  readonly agentBackfills: Map<string, Promise<void>>;
  readonly opsJournals: Map<string, AgentOpsJournal>;
}

interface AgentOpsJournal {
  nextSeq: number;
  batches: { seq: number; ops: TranscriptOperation[] }[];
}

/** Retained op batches per agent; older batches evict (catch-up turns incomplete). */
export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

/** Catch-up view over one agent's journal: batches with seq > sinceSeq, oldest first. */
export interface TranscriptOpsCatchup {
  readonly batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[];
  readonly latestSeq: number;
  /** false when the journal no longer reaches back to sinceSeq — the caller must do a full refresh. */
  readonly complete: boolean;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<
    string,
    Set<(event: TranscriptChangeEvent, seq: number) => void>
  >();
  /** Debounced post-turn heals: `${sessionId}:${agentId}` → pending ordinals + timer. */
  private readonly healTimers = new Map<string, { ordinals: Set<number>; timer: NodeJS.Timeout }>();

  constructor(private readonly deps: TranscriptServiceDeps) {
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.dropSession(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.dropSession(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(sessionId: string): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.store;
      }
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId);
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(store, session, this.deps.logger, (event) =>
        this.handleLiveOps(sessionId, event),
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    this.live.set(sessionId, {
      store,
      binding,
      ready: (async () => {
        await this.backfillMain(sessionId, store);
        if (this.live.get(sessionId)?.store === store) {
          binding.seedPendingInteractions(MAIN_AGENT_ID);
        }
      })(),
      agentBackfills: new Map(),
      opsJournals: new Map(),
    });
    return store;
  }

  /**
   * Resolves when the session's initial history backfill has landed (or
   * immediately when the session has no live store). Full-read consumers
   * (REST route, WS subscribe) await this so the first answer carries the
   * established main-agent transcript.
   */
  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  /**
   * Ensure one agent's persisted history is replayed into the live store
   * (idempotent per agent; the main agent is already covered by the initial
   * backfill). Awaited by full-read consumers for the `agent_id` they serve,
   * so any agent's transcript — including subagents that are not
   * materialized in this process — comes back established.
   */
  async ensureAgentHistory(sessionId: string, agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return this.whenReady(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    await entry.ready;
    let backfill = entry.agentBackfills.get(agentId);
    if (backfill === undefined) {
      backfill = this.backfillAgent(sessionId, entry.store, agentId);
      entry.agentBackfills.set(agentId, backfill);
    }
    await backfill;
    if (this.live.get(sessionId)?.store === entry.store) {
      entry.binding.seedPendingInteractions(agentId);
    }
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(sessionId: string, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID);
    if (this.live.get(sessionId)?.store !== store) return;
    try {
      const session = getLiveSessionById(this.deps.core.accessor, sessionId);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {
    }
  }

  /**
   * Replay one agent's persisted wire records into its transcript. Everything
   * is an idempotent upsert (never `reset`), so live ops arriving while the
   * records are read from disk survive the merge; turn ordinals assigned by
   * the rebuild are 0-based like the engine's, so future live turns continue
   * without colliding.
   */
  private async backfillAgent(sessionId: string, store: TranscriptStore, agentId: string): Promise<void> {
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(sessionId, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    if (this.live.get(sessionId)?.store !== store) return;
    const transcript = store.ensureAgent(agentId);
    if (snapshot !== undefined) {
      const superseded = supersededColdAttachmentIds(snapshot, transcript);
      const ops = snapshotToOps(snapshot, (turn) =>
        healTurnOps(turn, transcript.getTurn(turn.turnId)),
      ).filter(
        (op) => op.op !== 'attachment.upsert' || !superseded.has(op.attachment.attachmentId),
      );
      const overlay = this.liveTurnOverlay(sessionId, agentId, transcript, snapshot);
      if (overlay !== undefined) ops.push(overlay);
      const result = transcript.apply(ops);
      if (result.gap !== undefined) {
        this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
      }
      this.dispatchOps(sessionId, { agentId, ops });
    }
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
  }

  /**
   * Subscribe to the session's mapped-op stream (one shared subscription per
   * session — the broadcaster fans grades out against it). These are the
   * projector-mapped ops, not the store's accepted ops; see
   * `bindSessionTranscript` for why. Each batch carries its per-agent seq
   * (consecutive from 1; 0 only when the session has no live entry, which a
   * registered listener cannot observe). Returns `undefined` when the session
   * is not live (caller skips streaming for cold sessions).
   */
  onSessionOps(
    sessionId: string,
    listener: (event: TranscriptChangeEvent, seq: number) => void,
  ): IDisposable | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    let listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(sessionId);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(sessionId);
      },
    };
  }

  private dispatchOps(sessionId: string, event: TranscriptChangeEvent): void {
    const seq = this.journalOps(sessionId, event);
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, seq);
      } catch {
      }
    }
  }

  /**
   * Append one dispatched batch to its agent's journal and assign the next
   * consecutive seq. Journaling happens before the fan-out (and regardless of
   * listeners), so the watermark always covers every dispatched batch. Returns
   * 0 when the session has no live entry — the journal dies with the store.
   */
  private journalOps(sessionId: string, event: TranscriptChangeEvent): number {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return 0;
    let journal = entry.opsJournals.get(event.agentId);
    if (journal === undefined) {
      journal = { nextSeq: 1, batches: [] };
      entry.opsJournals.set(event.agentId, journal);
    }
    const seq = journal.nextSeq++;
    journal.batches.push({ seq, ops: [...event.ops] });
    if (journal.batches.length > TRANSCRIPT_OPS_JOURNAL_CAPACITY) journal.batches.shift();
    return seq;
  }

  /**
   * Watermark for one agent: the seq of its latest dispatched op batch (0 when
   * nothing was dispatched — or the session is not live, cold sessions having
   * no journal).
   */
  getSeqWatermark(sessionId: string, agentId: string): number {
    const journal = this.live.get(sessionId)?.opsJournals.get(agentId);
    return journal === undefined ? 0 : journal.nextSeq - 1;
  }

  /**
   * Point-to-point catch-up: the journaled batches with seq > `sinceSeq`,
   * oldest first. `complete` is true only when every batch in
   * (sinceSeq, latestSeq] is retained — a sinceSeq ahead of the watermark
   * (stale cursor from a dead journal incarnation) or one the bounded journal
   * has already evicted yields `complete: false`, telling the caller to fall
   * back to a full refresh. Returns `undefined` when the session is not live
   * (cold sessions have no journal).
   */
  getOpsSince(
    sessionId: string,
    agentId: string,
    sinceSeq: number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    const journal = this.live.get(sessionId)?.opsJournals.get(agentId);
    const latestSeq = journal === undefined ? 0 : journal.nextSeq - 1;
    if (sinceSeq > latestSeq) return { batches: [], latestSeq, complete: false };
    const batches = journal?.batches.filter((batch) => batch.seq > sinceSeq) ?? [];
    const oldest = journal?.batches[0]?.seq;
    const complete = batches.length === 0 || (oldest !== undefined && oldest <= sinceSeq + 1);
    return { batches, latestSeq, complete };
  }

  /**
   * Live (projector-mapped) op batches: fan out, then watch for terminal
   * turns to heal. Backfill batches go through `dispatchOps` directly so a
   * replayed history cannot retrigger heals.
   */
  private handleLiveOps(sessionId: string, event: TranscriptChangeEvent): void {
    this.dispatchOps(sessionId, event);
    for (const op of event.ops) {
      if (op.op === 'turn.upsert' && TERMINAL_TURN_STATES.has(op.turn.state)) {
        this.scheduleTurnHeal(sessionId, event.agentId, op.turn.ordinal);
      }
    }
  }

  private scheduleTurnHeal(sessionId: string, agentId: string, ordinal: number): void {
    const key = `${sessionId}:${agentId}`;
    const existing = this.healTimers.get(key);
    if (existing !== undefined) {
      existing.ordinals.add(ordinal);
      existing.timer.refresh();
      return;
    }
    const ordinals = new Set([ordinal]);
    const timer = setTimeout(() => {
      this.healTimers.delete(key);
      void this.healEndedTurns(sessionId, agentId, ordinals);
    }, TURN_HEAL_DEBOUNCE_MS);
    timer.unref();
    this.healTimers.set(key, { ordinals, timer });
  }

  /**
   * A backfill rebuilds every turn as 'completed' — the cold grouping cannot
   * see in-flight work. When the agent's loop is actually mid-turn, re-assert
   * the active turn's header as 'running' AFTER the snapshot ops (its cold
   * 'completed' header would otherwise win, even over a live running header
   * the projector already wrote). Live header fields win, then the
   * snapshot's. Returns `undefined` only when the loop is idle.
   */
  private liveTurnOverlay(
    sessionId: string,
    agentId: string,
    transcript: AgentTranscript,
    snapshot: AgentTranscriptSnapshot,
  ): TranscriptOperation | undefined {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent =
      session === undefined
        ? undefined
        : session.accessor.get(IAgentLifecycleService).findAgentHandle(agentId);
    const status = agent?.accessor.get(IAgentLoopService).status();
    if (status?.state !== 'running' || status.activeTurnId === undefined) return undefined;
    const ordinal = status.activeTurnId;
    const turnId = `t${ordinal}`;
    const existing = transcript.getTurn(turnId);
    const snapshotTurn = snapshot.items.find(
      (item): item is TranscriptTurn => item.kind === 'turn' && item.ordinal === ordinal,
    );
    return {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'running',
        origin: existing?.origin ?? snapshotTurn?.origin ?? { kind: 'other' },
        prompt: existing?.prompt ?? snapshotTurn?.prompt,
        attachmentIds: existing?.attachmentIds ?? snapshotTurn?.attachmentIds,
        startedAt: existing?.startedAt ?? snapshotTurn?.startedAt,
      },
    };
  }

  /**
   * Re-read the agent's persisted history and merge the ended turn(s) back
   * into the live store. The projector attaches to the bus at bind time, so
   * text streamed (and persisted) before that is missing from its frames; by
   * the time a turn ends, its records are complete on disk. The merge is
   * deliberately conservative (`healTurnOps`): live state wins everywhere
   * except the one regression being healed — truncated text/thinking frames.
   */
  private async healEndedTurns(
    sessionId: string,
    agentId: string,
    ordinals: ReadonlySet<number>,
  ): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(sessionId, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: post-turn heal failed, continuing without it',
      );
      return;
    }
    if (snapshot === undefined || this.live.get(sessionId)?.store !== entry.store) return;
    const transcript = entry.store.getAgent(agentId);
    if (transcript === undefined) return;
    const turnOps: TranscriptOperation[] = [];
    for (const item of snapshot.items) {
      if (item.kind !== 'turn' || !ordinals.has(item.ordinal)) continue;
      turnOps.push(...healTurnOps(item, transcript.getTurn(item.turnId)));
    }
    if (turnOps.length === 0) return;
    const superseded = supersededColdAttachmentIds(snapshot, transcript);
    const ops: TranscriptOperation[] = [
      ...snapshot.attachments
        .filter((attachment) => !superseded.has(attachment.attachmentId))
        .map((attachment) => ({
          op: 'attachment.upsert' as const,
          attachment,
        })),
      ...turnOps,
    ];
    transcript.apply(ops);
    this.dispatchOps(sessionId, { agentId, ops });
  }

  /**
   * Roster for a cold session, read from the persisted session metadata
   * (`<sessionDir>/state.json`) and mapped like the live seeding
   * (`descriptorFromMeta`). Returns `undefined` when the session is unknown
   * to the index; an unreadable or missing metadata file yields an empty
   * roster (best-effort — transcripts work without descriptors).
   */
  async readColdRoster(sessionId: string): Promise<AgentDescriptor[] | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    let meta: SessionMeta;
    try {
      const raw = await readFile(
        join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE),
        'utf-8',
      );
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      return [];
    }
    return Object.entries(meta.agents ?? {}).map(([agentId, agentMeta]) =>
      descriptorFromMeta(agentId, agentMeta),
    );
  }

  /**
   * Rebuild one agent's transcript snapshot for a cold session from its
   * persisted wire records. Returns `undefined` when the session is unknown to
   * the index; a known session without wire records for the agent yields an
   * empty snapshot.
   */
  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) {
      return groupMessagesIntoSnapshot([]);
    }
    const wirePath = join(
      this.deps.homeDir,
      SESSIONS_ROOT,
      summary.workspaceId,
      sessionId,
      AGENTS_DIR,
      agentId,
      WIRE_FILE,
    );
    let records: Awaited<ReturnType<typeof readWireRecords>>;
    try {
      records = await readWireRecords(wirePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return groupMessagesIntoSnapshot([]);
      }
      throw error;
    }
    const messages = [...reduceContextTranscript(records).entries];
    const base = groupMessagesIntoSnapshot(messages);
    return foldWireRecordFacts(records, base);
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(sessionId: string): void {
    this.opsListeners.delete(sessionId);
    for (const [key, pending] of this.healTimers) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(pending.timer);
        this.healTimers.delete(key);
      }
    }
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    entry.binding.dispose();
  }
}

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read. Global attachment entities flatten
 * too — without them a backfilled turn's `attachmentIds` would dangle.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

const TURN_HEAL_DEBOUNCE_MS = 250;
const TERMINAL_TURN_STATES: ReadonlySet<TranscriptTurn['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function supersededColdAttachmentIds(
  snapshot: AgentTranscriptSnapshot,
  transcript: AgentTranscript,
): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const item of snapshot.items) {
    if (item.kind !== 'turn' || item.attachmentIds === undefined) continue;
    const live = transcript.getTurn(item.turnId);
    if (live?.attachmentIds === undefined || live.attachmentIds.length === 0) continue;
    for (const id of item.attachmentIds) superseded.add(id);
  }
  return superseded;
}

/**
 * Merge one persisted (snapshot) turn back into the live store after the turn
 * ended — the post-turn heal for mid-turn attaches:
 *   - turn the live store never saw: taken wholesale;
 *   - header: the snapshot is authoritative for origin/prompt (it reads the
 *     persisted user message, which a mid-turn-attached projector missed);
 *     the live header wins on state, timestamps, and attachment ids (its
 *     `{turnId}.att<N>` entities are already projected — swapping in the
 *     snapshot's cold `att_<n>` ids would churn the references and orphan
 *     the live entities);
 *   - steps the live turn never saw: taken wholesale from the snapshot;
 *   - existing steps: text/thinking frames are re-emitted only when the
 *     persisted text is longer and the kind matches (a fresh live frame may
 *     still be ahead of a lagging flush); tool frames are re-emitted when
 *     the live step lacks the frame or the live frame lacks the outcome the
 *     persisted one carries (a tool.result dropped in the attach race is
 *     otherwise unrecoverable until a cold rebuild) — live-only extras
 *     (display / agentRefs / approvalId) are preserved on the emitted frame;
 *   - interactions are never re-emitted: they are global entities (not step
 *     content), are not persisted as context messages, and the live kernel
 *     bridge is always richer.
 */
export function healTurnOps(
  snapshotTurn: TranscriptTurn,
  liveTurn: TranscriptTurn | undefined,
): TranscriptOperation[] {
  const { steps, ...header } = snapshotTurn;
  const ops: TranscriptOperation[] = [];
  if (liveTurn === undefined) {
    ops.push({ op: 'turn.upsert', turn: header });
    for (const step of steps) {
      const { frames, ...stepHeader } = step;
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
    }
    return ops;
  }
  ops.push({
    op: 'turn.upsert',
    turn: {
      ...header,
      state: liveTurn.state,
      prompt: liveTurn.prompt ?? header.prompt,
      attachmentIds: liveTurn.attachmentIds ?? header.attachmentIds,
      startedAt: liveTurn.startedAt ?? header.startedAt,
      endedAt: liveTurn.endedAt ?? header.endedAt,
    },
  });
  for (const step of steps) {
    const liveStep = liveTurn.steps.find((entry) => entry.stepId === step.stepId);
    const { frames, ...stepHeader } = step;
    if (liveStep === undefined) {
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
      continue;
    }
    for (const frame of frames) {
      const liveFrame = liveStep.frames.find((entry) => entry.frameId === frame.frameId);
      if (frame.kind === 'tool') {
        const liveTool = liveFrame?.kind === 'tool' ? liveFrame : undefined;
        const liveHasOutcome =
          liveTool !== undefined && (liveTool.output !== undefined || liveTool.error !== undefined);
        const snapshotHasOutcome = frame.output !== undefined || frame.error !== undefined;
        if (liveTool !== undefined && (liveHasOutcome || !snapshotHasOutcome)) continue;
        ops.push({
          op: 'frame.upsert',
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame:
            liveTool === undefined
              ? frame
              : {
                  ...frame,
                  display: liveTool.display ?? frame.display,
                  agentRefs: liveTool.agentRefs ?? frame.agentRefs,
                  approvalId: liveTool.approvalId ?? frame.approvalId,
                },
        });
        continue;
      }
      if (frame.kind !== 'text' && frame.kind !== 'thinking') continue;
      if (
        liveFrame !== undefined &&
        liveFrame.kind === frame.kind &&
        (liveFrame.kind === 'text' || liveFrame.kind === 'thinking') &&
        liveFrame.text.length >= frame.text.length
      ) {
        continue;
      }
      ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}
