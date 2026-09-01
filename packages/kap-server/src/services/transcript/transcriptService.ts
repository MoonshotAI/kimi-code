import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  IAgentLifecycleService,
  IAgentPromptService,
  IFlagService,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  IAgentLoopService,
  TOWER_FLAG_ID,
  followSessionLifecycles,
  getLiveSessionById,
  isTowerFeatureAssembled,
  isUndoAnchor,
  reduceContextTranscript,
  type ContextMessage,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';
import {
  TowerStore,
  resolveTowerRepoRoot,
} from '@moonshot-ai/agent-core-v2/features/tower/protocol/index';
import {
  TranscriptStore,
  foldWireRecordFacts,
  groupMessagesIntoSnapshot,
  isPlainAgentId,
  type AgentDescriptor,
  type ActivityMeta,
  type AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import { readWireRecords, type ContextRecord } from './wireRecords';
import { toWireQuestion } from '../../protocol/question-wire';
import { projectPromptContentParts } from '../messages/messageProjection';
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

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

export interface TranscriptOpsCatchup {
  readonly batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[];
  readonly latestSeq: number;
  readonly complete: boolean;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<
    string,
    Set<(event: TranscriptChangeEvent, seq: number) => void>
  >();
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

  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

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
      if (overlay !== undefined) ops.push(overlay, { op: 'meta.merge', meta: { activity: 'turn' } });
      ops.push(...this.livePromptBackfill(sessionId, agentId));
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

  getSeqWatermark(sessionId: string, agentId: string): number {
    const journal = this.live.get(sessionId)?.opsJournals.get(agentId);
    return journal === undefined ? 0 : journal.nextSeq - 1;
  }

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
        : session.accessor.get(IAgentLifecycleService).handleOf(agentId);
    const status = agent?.accessor.get(IAgentLoopService).status();
    if (status?.state !== 'running' || status.activeTurnId === undefined) return undefined;
    const promptService = agent?.accessor.get(IAgentPromptService);
    const activePromptId = promptService?.list().active?.id;
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
        triggerPromptId: existing?.triggerPromptId ?? snapshotTurn?.triggerPromptId ?? activePromptId,
        origin: existing?.origin ?? snapshotTurn?.origin ?? { kind: 'other' },
        prompt: existing?.prompt ?? snapshotTurn?.prompt,
        attachmentIds: existing?.attachmentIds ?? snapshotTurn?.attachmentIds,
        startedAt: existing?.startedAt ?? snapshotTurn?.startedAt,
      },
    };
  }

  private livePromptBackfill(sessionId: string, agentId: string): TranscriptOperation[] {
    const agent = getLiveSessionById(this.deps.core.accessor, sessionId)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(agentId);
    const promptService = agent === undefined ? undefined : agent.accessor.get(IAgentPromptService);
    const queue = promptService?.list();
    if (queue === undefined) return [];
    const ops: TranscriptOperation[] = [];
    if (queue.active !== undefined) {
      ops.push({
        op: 'prompt.upsert',
        prompt: {
          promptId: queue.active.id,
          status: 'running',
          userMessageId: queue.active.userMessageId,
          content: projectPromptContentParts(queue.active.message.content),
          createdAt: queue.active.createdAt,
        },
      });
    }
    for (const pending of queue.pending) {
      ops.push({
        op: 'prompt.upsert',
        prompt: {
          promptId: pending.id,
          status: 'queued',
          userMessageId: pending.userMessageId,
          content: projectPromptContentParts(pending.message.content),
          createdAt: pending.createdAt,
        },
      });
    }
    return ops;
  }

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
    const taskOriginTurnTaskIds = new Set<string>();
    const steeredContents = new Map<string, Map<string, number>>();
    const anchorStack: { taskIdsSnapshot: Set<string> }[] = [];
    let anchorFloor = 0;
    let sawTurnPrompt = false;
    for (const record of records) {
      if (record.type === 'context.undo') {
        const count = typeof record['count'] === 'number' ? (record['count'] as number) : 0;
        for (let i = 0; i < count && anchorStack.length > anchorFloor; i++) {
          const popped = anchorStack.pop()!;
          taskOriginTurnTaskIds.clear();
          for (const id of popped.taskIdsSnapshot) taskOriginTurnTaskIds.add(id);
        }
        continue;
      }
      if (record.type === 'context.clear') {
        anchorFloor = anchorStack.length;
        continue;
      }
      if (record.type === 'context.append_message') {
        const message = (record as { message?: ContextMessage }).message;
        if (message !== undefined && isUndoAnchor(message)) {
          anchorStack.push({ taskIdsSnapshot: new Set(taskOriginTurnTaskIds) });
        }
        continue;
      }
      if (record.type === 'turn.steer') {
        const input = record['input'];
        if (Array.isArray(input)) {
          const key = JSON.stringify(input);
          const steerOrigin = (record as { origin?: { kind?: unknown } }).origin?.kind;
          const kind = typeof steerOrigin === 'string' ? steerOrigin : 'user';
          const byKind = steeredContents.get(key) ?? new Map<string, number>();
          byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
          steeredContents.set(key, byKind);
        }
        continue;
      }
      if (record.type !== 'turn.prompt') continue;
      sawTurnPrompt = true;
      const origin = (record as { origin?: { kind?: unknown; taskId?: unknown } }).origin;
      if (origin === undefined) continue;
      if (
        (origin.kind === 'task' || origin.kind === 'background_task') &&
        typeof origin.taskId === 'string'
      ) {
        taskOriginTurnTaskIds.add(origin.taskId);
      }
    }
    const base = groupMessagesIntoSnapshot(
      messages,
      sawTurnPrompt || steeredContents.size > 0 ? { taskOriginTurnTaskIds, steeredContents } : undefined,
    );
    const folded = foldWireRecordFacts(projectQuestionInteractionRecords(records, sessionId), base);
    const status = getLiveSessionById(this.deps.core.accessor, sessionId)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(agentId)
      ?.accessor.get(IAgentLoopService)
      .status();
    const activity: ActivityMeta = status?.state === 'running' ? 'turn' : 'idle';
    const snapshot = { ...folded, meta: { ...folded.meta, activity } };
    if (snapshot.meta.modes?.tower === undefined) return snapshot;
    const flags = this.deps.core.accessor.get(IFlagService);
    if (
      agentId === MAIN_AGENT_ID &&
      flags.enabled(TOWER_FLAG_ID) &&
      isTowerFeatureAssembled(flags) &&
      (await this.coldTowerOwnedHere(sessionId, summary.cwd))
    ) {
      return snapshot;
    }
    const modes = { ...snapshot.meta.modes, tower: undefined };
    const cleared = modes.plan === undefined && modes.swarm === undefined && modes.tower === undefined;
    return { ...snapshot, meta: { ...snapshot.meta, modes: cleared ? undefined : modes } };
  }

  private async coldTowerOwnedHere(sessionId: string, cwd: string | undefined): Promise<boolean> {
    if (cwd === undefined) return true;
    const owner = await new TowerStore(resolveTowerRepoRoot(cwd))
      .load()
      .then((state) => state.sessionId, () => undefined);
    if (owner === undefined || owner === sessionId) return true;
    return this.deps.core.accessor.get(ISessionManager).get(owner) === undefined;
  }

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

function projectQuestionInteractionRecords(
  records: readonly ContextRecord[],
  sessionId: string,
): ContextRecord[] {
  return records.map((record) => {
    if (record.type !== 'interaction.request' || record['kind'] !== 'question') return record;
    const id = record['id'];
    const request = record['request'];
    const time = record['time'];
    if (typeof id !== 'string' || typeof time !== 'number' || !Number.isFinite(time)) {
      return record;
    }
    if (request === null || typeof request !== 'object') return record;
    try {
      const innerToolCallId = (request as { toolCallId?: unknown }).toolCallId;
      const toolCallId =
        typeof record['toolCallId'] === 'string'
          ? record['toolCallId']
          : typeof innerToolCallId === 'string'
            ? innerToolCallId
            : undefined;
      return {
        ...record,
        toolCallId,
        request: toWireQuestion({ id, createdAt: time, payload: request }, sessionId),
      };
    } catch {
      return record;
    }
  });
}

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
      triggerPromptId: liveTurn.triggerPromptId ?? header.triggerPromptId,
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
