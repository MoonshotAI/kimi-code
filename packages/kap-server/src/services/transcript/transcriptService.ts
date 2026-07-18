/**
 * `TranscriptService` — kap-server's session-level transcript owner.
 *
 * Live path: one `TranscriptStore` per in-memory session, bound to the core
 * engine via {@link bindSessionTranscript} on first use (idempotent) and torn
 * down by {@link dropSession} (wired to the broadcaster's close path). A
 * session that is not live in this process yields `undefined` — transcript WS
 * streaming only covers live sessions, while cold reads go through
 * {@link readColdSnapshot}.
 *
 * Backfill: a freshly created live store starts empty — the binding only
 * projects events from attach time on. To make full reads (REST pages, WS
 * resets) meaningful for sessions with history, store creation kicks off an
 * idempotent backfill that replays the persisted wire records into the main
 * agent's transcript as ordinary upsert ops (never `reset`, so concurrently
 * arriving live ops survive) and seeds the roster from the session's
 * persisted agent registry. Any other agent's history is replayed on demand
 * via {@link ensureAgentHistory}. Consumers that need the established state
 * await {@link whenReady} / {@link ensureAgentHistory} (the REST route and
 * the WS subscribe path both do). The backfill also guarantees the main
 * agent's presence in the store roster, so a graded subscriber always has a
 * reset target.
 *
 * Cold path: rebuilds one agent's transcript from the persisted wire records
 * (`<sessionDir>/agents/<agentId>/wire.jsonl`), exactly the
 * `SnapshotReader` read (`readWireRecords` + `reduceContextTranscript`), then
 * groups the flat messages into a snapshot via
 * `groupMessagesIntoSnapshot` — best-effort fidelity.
 */

import { join } from 'node:path';

import {
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  reduceContextTranscript,
  type IDisposable,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  TranscriptStore,
  groupMessagesIntoSnapshot,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import { readWireRecords } from '../snapshot/snapshotReader';
import {
  bindSessionTranscript,
  descriptorFromMeta,
  type TranscriptBindingLogger,
} from './coreBinding';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const MAIN_AGENT_ID = 'main';
const WIRE_FILE = 'wire.jsonl';

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: IDisposable;
  /** Resolves when the initial main-agent history backfill has landed. */
  readonly ready: Promise<void>;
  /** Per-agent history backfill promises (dedupe concurrent ensures). */
  readonly agentBackfills: Map<string, Promise<void>>;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<string, Set<(event: TranscriptChangeEvent) => void>>();

  constructor(private readonly deps: TranscriptServiceDeps) {}

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(sessionId: string): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) return existing.store;
    const session = this.deps.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId);
    let binding: IDisposable;
    try {
      binding = bindSessionTranscript(store, session, this.deps.logger, (event) =>
        this.dispatchOps(sessionId, event),
      );
    } catch (error) {
      // The session's core scope can be disposed mid-bind during shutdown
      // (same guard as the broadcaster's `ensureState`).
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    this.live.set(sessionId, {
      store,
      binding,
      ready: this.backfillMain(sessionId, store),
      agentBackfills: new Map(),
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
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(sessionId: string, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID);
    if (this.live.get(sessionId)?.store !== store) return;
    // Seed the roster from the session's persisted agent registry, so full
    // reads (and agent pickers) see the complete historical roster —
    // including subagents not materialized in this process.
    try {
      const session = this.deps.core.accessor.get(ISessionLifecycleService).get(sessionId);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {
      // Roster seeding is best-effort; transcripts work without descriptors.
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
    // The entry may have been dropped (session closed) while reading from disk.
    if (this.live.get(sessionId)?.store !== store) return;
    const transcript = store.ensureAgent(agentId);
    if (snapshot !== undefined) {
      const ops = snapshotToOps(snapshot);
      const result = transcript.apply(ops);
      if (result.gap !== undefined) {
        this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
      }
      // Fan the backfill out like any mapped-op batch so attached subscribers
      // converge; later resets carry it wholesale anyway.
      this.dispatchOps(sessionId, { agentId, ops });
    }
    // Land the roster entry last, so roster-driven resets already see the
    // backfilled content — this also guarantees a reset target for agents
    // whose engine instance has not been created yet.
    store.describeAgent({ agentId, type: agentId === MAIN_AGENT_ID ? 'main' : 'sub' });
  }

  /**
   * Subscribe to the session's mapped-op stream (one shared subscription per
   * session — the broadcaster fans grades out against it). These are the
   * projector-mapped ops, not the store's accepted ops; see
   * `bindSessionTranscript` for why. Returns `undefined` when the session is
   * not live (caller skips streaming for cold sessions).
   */
  onSessionOps(
    sessionId: string,
    listener: (event: TranscriptChangeEvent) => void,
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
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // best-effort fan-out; a broken listener is dropped, not fatal
      }
    }
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
    return groupMessagesIntoSnapshot(messages);
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(sessionId: string): void {
    this.opsListeners.delete(sessionId);
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
 * landed while the records were being read.
 */
function snapshotToOps(snapshot: AgentTranscriptSnapshot): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      const { steps, ...header } = item;
      ops.push({ op: 'turn.upsert', turn: header });
      for (const step of steps) {
        const { frames, ...stepHeader } = step;
        ops.push({ op: 'step.upsert', turnId: item.turnId, step: stepHeader });
        for (const frame of frames) {
          ops.push({ op: 'frame.upsert', turnId: item.turnId, stepId: step.stepId, frame });
        }
      }
    } else if (item.kind === 'marker') {
      ops.push({ op: 'marker.upsert', item });
    } else {
      ops.push({ op: 'taskref.upsert', item });
    }
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}
