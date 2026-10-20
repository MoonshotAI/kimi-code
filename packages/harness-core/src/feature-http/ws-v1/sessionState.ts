import type { App } from '@moonshot-ai/agent-core/app/index';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';
import { createFacadeToken } from '@moonshot-ai/agent-core/kernel/index';
import type { UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import type { ConfigStore } from '#/features/config/index';
import { parseMediaRefUrl } from '#/features/media/ref';
import { PlanRef } from '#/features/plan/index';
import { PermissionRef } from '#/features/permission/index';
import {
  AgentModelRef,
  matchCatalogBinding,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import { TokenCountingRef } from '#/features/tokenCounting/index';

import { agentFacade } from '../scope';
import { sessionBusy, sessionPendingInteraction } from '../route-features/status';
import { sessionView } from '../route-builtin/sessions';
import { resumeSession } from '../route/resume-session';

import { EventJournal, TranscriptOpsJournal, type BufferedSinceResult, type EventEnvelope, type SessionCursor } from './journal';
import type { ResyncReason } from './protocol';
import {
  AgentTranscript,
  AgentTranscriptProjector,
  groupHistoryIntoSnapshot,
  parseToolArgs,
  projectPromptContent,
  snapshotToOps,
} from './transcript';
import {
  detachGrades,
  filterOpsForGrade,
  gradeFor,
  needsResetOnTransition,
  redactSnapshotForGrade,
  type AgentTranscriptSnapshot,
  type TranscriptGrade,
  type TranscriptGradeSpec,
  type TranscriptOperation,
} from './transcriptModel';

export type AgentFilter = ReadonlySet<string> | undefined;

export interface TargetSubscription {
  readonly agentFilter?: AgentFilter;
  readonly transcriptGrades?: TranscriptGradeSpec;
}

export type BroadcastDelivery = 'subscription' | 'immediate';

export interface BroadcastTarget {
  send(envelope: EventEnvelope, delivery?: BroadcastDelivery): void;
}

const GLOBAL_SESSION_ID = '__global__';

const VOLATILE_WIRE_TYPES: ReadonlySet<string> = new Set([
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
]);

const TRANSCRIPT_PROJECTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn.started',
  'turn.ended',
  'turn.step.started',
  'turn.step.completed',
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
  'subagent.spawned',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled',
  'subagent.suspended',
  'compaction.started',
  'compaction.blocked',
  'compaction.cancelled',
  'compaction.completed',
  'skill.activated',
  'cron.fired',
  'error',
  'warning',
  'goal.updated',
  'context.spliced',
  'agent.status.updated',
  'prompt.submitted',
  'prompt.started',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
  'event.question.requested',
  'event.question.dismissed',
  'event.question.answered',
  'event.approval.requested',
  'event.approval.resolved',
]);

interface WireOut {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface PendingTurn {
  turnId: number;
  wireEmitted: boolean;
}

interface AgentTrack {
  offs: Array<() => void>;
  currentTurnId?: number;
  promptByTurnId: Map<number, string>;
  pendingTurn?: PendingTurn;
}

interface TranscriptStream {
  transcript: AgentTranscript;
  projector: AgentTranscriptProjector;
  ops: TranscriptOpsJournal;
}

interface SessionState {
  readonly sessionId: string;
  readonly handle: Session;
  readonly journal: EventJournal;
  readonly tracker: InFlightTurnTracker;
  readonly targets: Map<BroadcastTarget, TargetSubscription>;
  queue: Promise<void>;
  readonly agentTracks: Map<string, AgentTrack>;
  readonly transcripts: Map<string, TranscriptStream>;
  readonly transcriptSeeded: Set<BroadcastTarget>;
  readonly deferredTranscriptSeeds: Map<
    BroadcastTarget,
    { readonly spec: TranscriptGradeSpec; readonly transcriptSince?: Record<string, number> }
  >;
  readonly towerParents: Map<string, string>;
  lastWorkChanged?: string;
}

class InFlightTurnTracker {
  private turnId?: number;
  private assistantText = '';
  private thinkingText = '';

  apply(event: { type: string; [key: string]: unknown }): { offset?: number } {
    switch (event.type) {
      case 'turn.started':
        this.turnId = event['turnId'] as number;
        this.assistantText = '';
        this.thinkingText = '';
        return {};
      case 'turn.ended':
        this.turnId = undefined;
        return {};
      case 'turn.step.started':
        this.assistantText = '';
        this.thinkingText = '';
        return {};
      case 'assistant.delta': {
        if (this.turnId !== event['turnId']) return {};
        const offset = this.assistantText.length;
        this.assistantText += event['delta'] as string;
        return { offset };
      }
      case 'thinking.delta': {
        if (this.turnId !== event['turnId']) return {};
        const offset = this.thinkingText.length;
        this.thinkingText += event['delta'] as string;
        return { offset };
      }
      default:
        return {};
    }
  }
}

export interface SessionBroadcasterOptions {
  readonly app: App;
  readonly root: UnitNode;
  readonly bindings: () => readonly CatalogModelBinding[];
  readonly config: () => ConfigStore | undefined;
  readonly maxBufferSize: number;
  readonly inlineMediaRef?: (sessionId: string, url: string) => Promise<string | undefined>;
}

export const WsV1BroadcasterRef = createFacadeToken<SessionBroadcaster>('http.wsV1Broadcaster');

export class SessionBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  private readonly globalTargets = new Set<BroadcastTarget>();
  private globalState: { journal: EventJournal; queue: Promise<void> } | undefined;
  private closed = false;

  constructor(private readonly opts: SessionBroadcasterOptions) {}

  addGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.add(target);
  }

  removeGlobalTarget(target: BroadcastTarget): void {
    this.globalTargets.delete(target);
  }

  hasState(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  transcriptStreamState(
    sessionId: string,
    agentId: string,
  ): { snapshot(): AgentTranscriptSnapshot; watermark: number } | undefined {
    const stream = this.sessions.get(sessionId)?.transcripts.get(agentId);
    if (stream === undefined) return undefined;
    return {
      snapshot: () => stream.transcript.snapshot(),
      watermark: stream.ops.watermark,
    };
  }

  onAppEvent(event: RuntimeEvent): void {
    if (this.closed) return;
    const type = event.type;
    if (type === 'session.created') {
      const sessionId = event['sessionId'];
      if (typeof sessionId === 'string') this.onSessionCreated(sessionId);
      return;
    }
    if (type === 'session.deleted') {
      const sessionId = event['sessionId'];
      if (typeof sessionId === 'string') this.onSessionDeleted(sessionId);
      return;
    }
    if (type === 'workspace.created' || type === 'workspace.updated') {
      this.onWorkspaceEvent(
        type === 'workspace.created' ? 'event.workspace.created' : 'event.workspace.updated',
        workspaceWireOf(event),
      );
      return;
    }
    if (type === 'workspace.deleted') {
      const workspaceId = event['workspaceId'];
      if (typeof workspaceId !== 'string') return;
      this.onWorkspaceEvent('event.workspace.deleted', {
        workspace_id: workspaceId,
        root: typeof event['root'] === 'string' ? event['root'] : '',
        agentId: MAIN_AGENT_ID,
      });
      return;
    }
    if (type === 'plugin.changed') {
      this.onGlobalEvent('event.plugin.changed', { agentId: MAIN_AGENT_ID });
      return;
    }
    if (type === 'capability.changed') {
      const id = event['id'];
      if (typeof id !== 'string') return;
      this.onGlobalEvent('event.capability.changed', {
        capability_id: id,
        install: event['install'],
        agentId: MAIN_AGENT_ID,
      });
      return;
    }
    const sessionId = event['sessionId'];
    if (typeof sessionId !== 'string') return;
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.enqueueSessionEvent(state, event as unknown as Record<string, unknown>);
  }

  async subscribe(
    sessionId: string,
    target: BroadcastTarget,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
    opts?: { deferTranscriptReset?: boolean; transcriptSince?: Record<string, number> },
  ): Promise<boolean> {
    const state = await this.ensureStateResumed(sessionId);
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
        let gated = false;
        for (const agentId of this.knownAgentIds(state)) {
          const grade = gradeFor(transcriptGrades, agentId);
          if (grade === 'off') continue;
          if (needsResetOnTransition(gradeFor(prev?.transcriptGrades, agentId), grade)) {
            gated = true;
            break;
          }
        }
        if (gated) state.transcriptSeeded.delete(target);
        await this.subscribeTranscript(state, target, transcriptGrades, prev?.transcriptGrades, opts?.transcriptSince);
        if (state.targets.has(target)) state.transcriptSeeded.add(target);
      }
    }
    return true;
  }

  private async subscribeTranscript(
    state: SessionState,
    target: BroadcastTarget,
    spec: TranscriptGradeSpec,
    prev: TranscriptGradeSpec | undefined,
    transcriptSince?: Record<string, number>,
  ): Promise<void> {
    for (const agentId of this.knownAgentIds(state, spec)) {
      const grade = gradeFor(spec, agentId);
      if (grade === 'off') continue;
      const stream = await this.ensureTranscript(state, agentId);
      if (stream === undefined) continue;
      const since = transcriptSince?.[agentId] ?? transcriptSince?.['*'];
      if (since !== undefined) {
        const catchup = stream.ops.since(since);
        if (catchup.complete) {
          for (const batch of catchup.batches) {
            const filtered = filterOpsForGrade(grade, batch.ops);
            if (filtered.length === 0) continue;
            this.sendTranscriptFrame(state, target, 'transcript.ops', {
              type: 'transcript.ops',
              agent_id: agentId,
              ops: filtered,
              seq: batch.seq,
            });
          }
          continue;
        }
      }
      if (!needsResetOnTransition(gradeFor(prev, agentId), grade)) continue;
      this.sendTranscriptReset(state, target, agentId, grade);
    }
  }

  private sendTranscriptReset(
    state: SessionState,
    target: BroadcastTarget,
    agentId: string,
    grade: TranscriptGrade,
  ): void {
    const stream = state.transcripts.get(agentId);
    if (stream === undefined) return;
    const snapshot = redactSnapshotForGrade(grade, stream.transcript.snapshot());
    this.sendTranscriptFrame(state, target, 'transcript.reset', {
      type: 'transcript.reset',
      agent_id: agentId,
      snapshot,
      has_more_older: snapshot.hasMoreOlder ?? false,
      seq: stream.ops.watermark,
    });
  }

  private sendTranscriptFrame(
    state: SessionState,
    target: BroadcastTarget,
    type: 'transcript.reset' | 'transcript.ops',
    payload: Record<string, unknown>,
  ): void {
    target.send({
      type,
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      volatile: true,
      session_id: state.sessionId,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

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

  unsubscribeTranscript(sessionId: string, target: BroadcastTarget, agentIds?: readonly string[]): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const sub = state.targets.get(target);
    if (sub === undefined) return;
    const next = agentIds === undefined ? undefined : detachGrades(sub.transcriptGrades, agentIds);
    state.targets.set(target, { agentFilter: sub.agentFilter, transcriptGrades: next });
    if (next === undefined) {
      state.transcriptSeeded.delete(target);
      state.deferredTranscriptSeeds.delete(target);
    }
  }

  async getBufferedSince(
    sessionId: string,
    cursor: SessionCursor,
    filter?: AgentFilter,
    transcriptGrades?: TranscriptGradeSpec,
  ): Promise<BufferedSinceResult> {
    const state = await this.ensureStateResumed(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    await state.queue;
    const result = state.journal.bufferedSince(cursor);
    if (result.resyncRequired !== false) return result;
    const events =
      filter === undefined && transcriptGrades === undefined
        ? result.events
        : result.events.filter(
            ({ envelope }) =>
              matchesAgentFilter(envelope, filter) &&
              !suppressedByTranscript(envelope, transcriptGrades),
          );
    return { ...result, events };
  }

  async getCursor(sessionId: string): Promise<{ seq: number; epoch: string }> {
    const state = await this.ensureStateResumed(sessionId);
    if (state === undefined) return { seq: 0, epoch: '' };
    await state.queue;
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  private async ensureStateResumed(sessionId: string): Promise<SessionState | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      if (this.opts.app.sessions.get(sessionId) !== undefined) return existing;
      this.dropState(sessionId);
    }
    if (this.opts.app.sessions.get(sessionId) === undefined) {
      await resumeSession(this.opts.app, sessionId).catch(() => undefined);
    }
    return this.ensureState(sessionId);
  }

  private dropState(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    this.sessions.delete(sessionId);
    for (const track of state.agentTracks.values()) {
      for (const off of track.offs) off();
    }
    state.targets.clear();
  }

  onSessionCreated(sessionId: string): void {
    void (async () => {
      const record = await this.opts.app.space.get(sessionId);
      if (record === undefined) return;
      const live = this.opts.app.sessions.get(sessionId);
      const session = await sessionView(this.opts.root, this.opts.bindings(), record, live, this.opts.config());
      this.dispatchSessionEvent(sessionId, {
        type: 'event.session.created',
        payload: { session, agentId: MAIN_AGENT_ID, sessionId },
      });
    })().catch(() => {});
  }

  onSessionDeleted(sessionId: string): void {
    this.dispatchGlobal({
      type: 'event.session.deleted',
      payload: { sessionId, workspace_id: '', agentId: MAIN_AGENT_ID, session_id: sessionId },
    });
    this.dropState(sessionId);
  }

  onSessionMetaUpdated(sessionId: string, meta: unknown): void {
    if (!this.sessions.has(sessionId)) return;
    this.dispatchSessionEvent(sessionId, {
      type: 'session.meta.updated',
      payload: { patch: meta, agentId: MAIN_AGENT_ID, sessionId },
    });
  }

  onWorkspaceEvent(type: string, payload: Record<string, unknown> | undefined): void {
    if (payload === undefined) return;
    this.dispatchGlobal({ type, payload });
  }

  onGlobalEvent(type: string, payload: Record<string, unknown>): void {
    this.dispatchGlobal({ type, payload });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.sessions.values()) {
      for (const track of state.agentTracks.values()) {
        for (const off of track.offs) off();
      }
      state.targets.clear();
    }
    this.sessions.clear();
    this.globalTargets.clear();
  }

  private ensureState(sessionId: string): SessionState | undefined {
    if (this.closed) return undefined;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const handle = this.opts.app.sessions.get(sessionId);
    if (handle === undefined) return undefined;
    const state: SessionState = {
      sessionId,
      handle,
      journal: new EventJournal(this.opts.maxBufferSize),
      tracker: new InFlightTurnTracker(),
      targets: new Map(),
      queue: Promise.resolve(),
      agentTracks: new Map(),
      transcripts: new Map(),
      transcriptSeeded: new Set(),
      deferredTranscriptSeeds: new Map(),
      towerParents: new Map(),
    };
    this.sessions.set(sessionId, state);
    for (const agentId of handle.agents.keys()) {
      void this.attachAgent(state, agentId).catch(() => {});
    }
    return state;
  }

  private async attachAgent(state: SessionState, agentId: string): Promise<void> {
    if (state.agentTracks.has(agentId)) return;
    const agent = state.handle.agents.get(agentId);
    if (agent === undefined) return;
    const track: AgentTrack = { offs: [], promptByTurnId: new Map() };
    state.agentTracks.set(agentId, track);
    track.offs.push(
      agent.loop.subscribe((event) => {
        this.enqueueAgentEvent(state, agentId, { ...(event as unknown as Record<string, unknown>) });
      }),
    );
    await this.ensureTranscript(state, agentId);
  }

  private detachAgent(state: SessionState, agentId: string): void {
    const track = state.agentTracks.get(agentId);
    if (track === undefined) return;
    for (const off of track.offs) off();
    state.agentTracks.delete(agentId);
  }

  private knownAgentIds(state: SessionState, spec?: TranscriptGradeSpec): string[] {
    const ids = new Set<string>([...state.transcripts.keys(), ...state.handle.agents.keys()]);
    if (spec !== undefined) {
      for (const key of Object.keys(spec)) {
        if (key !== '*') ids.add(key);
      }
    }
    return [...ids];
  }

  private async ensureTranscript(state: SessionState, agentId: string): Promise<TranscriptStream | undefined> {
    const existing = state.transcripts.get(agentId);
    if (existing !== undefined) return existing;
    const agent = state.handle.agents.get(agentId);
    if (agent === undefined) return undefined;
    const transcript = new AgentTranscript(agentId);
    const stream: TranscriptStream = {
      transcript,
      projector: new AgentTranscriptProjector(agentId, transcript),
      ops: new TranscriptOpsJournal(),
    };
    state.transcripts.set(agentId, stream);
    await agent.flush().catch(() => undefined);
    if (state.transcripts.get(agentId) !== stream) return stream;
    const snapshot = groupHistoryIntoSnapshot(agent.view.getState().messages);
    const ops = snapshotToOps(snapshot);
    if (ops.length > 0) {
      this.dispatchTranscriptOps(state, agentId, ops);
    }
    return stream;
  }

  private enqueueSessionEvent(state: SessionState, event: Record<string, unknown>): void {
    state.queue = state.queue
      .then(() => this.processSessionEvent(state, event))
      .catch(() => {});
  }

  private enqueueAgentEvent(state: SessionState, agentId: string, event: Record<string, unknown>): void {
    state.queue = state.queue
      .then(() => this.processAgentEvent(state, agentId, event))
      .catch(() => {});
  }

  private dispatchTranscriptOps(state: SessionState, agentId: string, ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0) return;
    const stream = state.transcripts.get(agentId);
    if (stream === undefined) return;
    stream.transcript.apply(ops);
    const seq = stream.ops.append(ops);
    for (const [target, sub] of state.targets) {
      if (!state.transcriptSeeded.has(target)) continue;
      const grade = gradeFor(sub.transcriptGrades, agentId);
      const filtered = filterOpsForGrade(grade, ops);
      if (filtered.length === 0) continue;
      try {
        this.sendTranscriptFrame(state, target, 'transcript.ops', {
          type: 'transcript.ops',
          agent_id: agentId,
          ops: filtered,
          seq,
        });
      } catch {
      }
    }
  }

  private async processAgentEvent(
    state: SessionState,
    agentId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (this.sessions.get(state.sessionId) !== state) return;
    const track = state.agentTracks.get(agentId);
    const type = event['type'] as string;
    if (type === 'turn.started' || type === 'turn.resumed') {
      const turnId = event['turnId'] as number;
      if (track !== undefined) {
        track.currentTurnId = turnId;
        track.pendingTurn = { turnId, wireEmitted: type === 'turn.resumed' };
      }
      if (type === 'turn.resumed') {
        this.dispatch(state, 'turn.started', { turnId, agentId, sessionId: state.sessionId }, false);
      }
    }
    if (type === 'message.appended') {
      this.emitPendingTurnStart(state, agentId, track, event);
    }
    const enriched: Record<string, unknown> =
      event['turnId'] === undefined && track?.currentTurnId !== undefined
        ? { ...event, turnId: track.currentTurnId }
        : event;
    const projected = await this.withInlinedMedia(state.sessionId, enriched);
    const stream = await this.ensureTranscript(state, agentId);
    if (stream !== undefined) {
      const ops = stream.projector.map(projected);
      this.dispatchTranscriptOps(state, agentId, ops);
    }
    const wireEvents = await this.mapAgentWireEvent(state, agentId, enriched, track);
    for (const wire of wireEvents) {
      this.dispatch(state, wire.type, wire.payload, VOLATILE_WIRE_TYPES.has(wire.type));
    }
    if (type === 'turn.ended' && track !== undefined) {
      track.promptByTurnId.delete(event['turnId'] as number);
      track.currentTurnId = undefined;
      track.pendingTurn = undefined;
    }
    this.maybeEmitWorkChanged(state);
  }

  private emitPendingTurnStart(
    state: SessionState,
    agentId: string,
    track: AgentTrack | undefined,
    event: Record<string, unknown>,
  ): void {
    const pending = track?.pendingTurn;
    if (track === undefined || pending === undefined || pending.wireEmitted) return;
    pending.wireEmitted = true;
    const entry = event['entry'] as
      | { message: { role: string; content: { type: string; text?: string }[] }; meta?: { promptId?: string; origin?: unknown } }
      | undefined;
    const isUser = entry?.message.role === 'user';
    const prompt = isUser
      ? entry.message.content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('')
      : undefined;
    this.dispatch(
      state,
      'turn.started',
      {
        turnId: pending.turnId,
        promptId: isUser ? entry.meta?.promptId : undefined,
        origin: isUser ? entry.meta?.origin : undefined,
        prompt: prompt !== undefined && prompt.length > 0 ? prompt : undefined,
        agentId,
        sessionId: state.sessionId,
      },
      false,
    );
    const promptId = isUser ? entry.meta?.promptId : undefined;
    if (promptId !== undefined) {
      track.promptByTurnId.set(pending.turnId, promptId);
      this.dispatch(state, 'prompt.started', { promptId, agentId, sessionId: state.sessionId }, false);
    }
  }

  private async withInlinedMedia(sessionId: string, event: Record<string, unknown>): Promise<Record<string, unknown>> {
    const inline = this.opts.inlineMediaRef;
    if (inline === undefined || event['type'] !== 'tool.ended') return event;
    const outcome = event['outcome'] as
      | { type?: unknown; entry?: { message?: { content?: unknown }; meta?: { isError?: unknown } } }
      | undefined;
    if (outcome?.type !== 'succeeded') return event;
    const content = outcome.entry?.message?.content;
    if (!Array.isArray(content)) return event;
    const parts = await Promise.all(
      content.map(async (part) => {
        if (part === null || typeof part !== 'object') return part;
        const record = part as { [key: string]: unknown; type?: unknown };
        if (record.type !== 'image_url' && record.type !== 'video_url' && record.type !== 'audio_url') {
          return part;
        }
        const source = record['source'] as { kind?: unknown; ref?: unknown } | undefined;
        if (source?.kind !== 'store' || typeof source.ref !== 'string') return part;
        if (parseMediaRefUrl(source.ref) === undefined) return part;
        const inlined = await inline(sessionId, source.ref).catch(() => undefined);
        return inlined === undefined ? part : { ...record, source: { kind: 'url', url: inlined } };
      }),
    );
    return { ...event, outcome: { ...outcome, entry: { ...outcome.entry, message: { ...outcome.entry?.message, content: parts } } } };
  }

  private async processSessionEvent(
    state: SessionState,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (this.sessions.get(state.sessionId) !== state) return;
    const type = event['type'] as string;
    const agentId = typeof event['agentId'] === 'string' ? (event['agentId'] as string) : undefined;
    switch (type) {
      case 'agent.registered': {
        if (agentId === undefined) return;
        this.dispatch(state, 'agent.created', { agentId, sessionId: state.sessionId }, false);
        return;
      }
      case 'agent.opened': {
        if (agentId === undefined) return;
        const isNew = !state.agentTracks.has(agentId);
        await this.attachAgent(state, agentId);
        if (isNew) {
          for (const [target, sub] of state.targets) {
            if (!state.transcriptSeeded.has(target)) continue;
            const grade = gradeFor(sub.transcriptGrades, agentId);
            if (grade === 'off') continue;
            this.sendTranscriptReset(state, target, agentId, grade);
          }
        }
        return;
      }
      case 'agent.closed': {
        if (agentId === undefined) return;
        this.detachAgent(state, agentId);
        this.dispatch(state, 'agent.disposed', { agentId, sessionId: state.sessionId }, false);
        this.maybeEmitWorkChanged(state);
        return;
      }
      case 'context.settled': {
        if (agentId === undefined) return;
        const stream = state.transcripts.get(agentId);
        const messages = event['messages'] as Parameters<typeof groupHistoryIntoSnapshot>[0] | undefined;
        if (stream !== undefined && messages !== undefined) {
          const snapshot = groupHistoryIntoSnapshot(messages);
          this.dispatchTranscriptOps(state, agentId, [{ op: 'reset', agentId, snapshot }]);
        }
        this.dispatch(
          state,
          'context.spliced',
          { agentId, sessionId: state.sessionId, reason: event['reason'] },
          false,
        );
        return;
      }
      case 'session.meta_updated': {
        this.dispatch(
          state,
          'session.meta.updated',
          { patch: event['meta'], agentId: MAIN_AGENT_ID, sessionId: state.sessionId },
          false,
        );
        return;
      }
      case 'interaction.requested':
      case 'interaction.resolved': {
        this.processInteractionEvent(state, event, agentId);
        this.maybeEmitWorkChanged(state);
        return;
      }
      case 'task.started':
      case 'task.settled': {
        const record = event['record'] as Record<string, unknown> | undefined;
        if (record === undefined) return;
        const legacyType = type === 'task.started' ? 'task.started' : 'task.terminated';
        const info = taskRecordToInfo(record);
        const payload = { info, agentId, sessionId: state.sessionId };
        this.dispatch(state, legacyType, payload, false);
        this.dispatch(
          state,
          type === 'task.started' ? 'background.task.started' : 'background.task.terminated',
          payload,
          false,
        );
        await this.routeOps(state, agentId, event);
        this.maybeEmitWorkChanged(state);
        return;
      }
      case 'todo.updated':
      case 'skill.activated':
      case 'goal.updated':
      case 'cron.fired': {
        if (type !== 'todo.updated') {
          this.dispatch(state, type, { ...withoutAgentId(event), agentId, sessionId: state.sessionId }, false);
        }
        await this.routeOps(state, agentId, event);
        return;
      }
      case 'compaction.started':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed': {
        const stats = event['stats'] as { tokensBefore?: number; tokensAfter?: number } | undefined;
        const summary = event['summary'];
        this.dispatch(
          state,
          type,
          {
            trigger: event['reason'] === 'manual' ? 'manual' : 'auto',
            instruction: event['instruction'],
            result:
              type === 'compaction.completed'
                ? {
                    tokensBefore: stats?.tokensBefore,
                    tokensAfter: stats?.tokensAfter,
                    summary:
                      typeof summary === 'string'
                        ? summary
                        : (summary as { text?: string } | undefined)?.text,
                  }
                : undefined,
            agentId,
            sessionId: state.sessionId,
          },
          false,
        );
        await this.routeOps(state, agentId, event);
        return;
      }
      case 'shell.started':
      case 'shell.output':
      case 'shell.completed': {
        this.dispatch(state, type, { ...withoutAgentId(event), agentId, sessionId: state.sessionId }, true);
        await this.routeOps(state, agentId, event);
        return;
      }
      case 'tower.spawned': {
        const childId = typeof event['agentId'] === 'string' ? (event['agentId'] as string) : undefined;
        const parentId =
          typeof event['parentAgentId'] === 'string' ? (event['parentAgentId'] as string) : MAIN_AGENT_ID;
        if (childId !== undefined) state.towerParents.set(childId, parentId);
        this.dispatch(
          state,
          'subagent.spawned',
          {
            subagentId: childId,
            subagentName: event['name'],
            description: event['description'],
            model: event['model'],
            runInBackground: true,
            agentId: parentId,
            sessionId: state.sessionId,
          },
          false,
        );
        await this.routeOps(state, parentId, event);
        return;
      }
      case 'tower.completed':
      case 'tower.failed':
      case 'tower.cancelled': {
        const childId = typeof event['agentId'] === 'string' ? (event['agentId'] as string) : undefined;
        const parentId = (childId !== undefined ? state.towerParents.get(childId) : undefined) ?? MAIN_AGENT_ID;
        const wireType =
          type === 'tower.completed'
            ? 'subagent.completed'
            : type === 'tower.failed'
              ? 'subagent.failed'
              : 'subagent.cancelled';
        this.dispatch(
          state,
          wireType,
          {
            subagentId: childId,
            resultSummary: event['summary'],
            usage: event['usage'],
            error: event['error'],
            agentId: parentId,
            sessionId: state.sessionId,
          },
          false,
        );
        await this.routeOps(state, parentId, event);
        this.maybeEmitWorkChanged(state);
        return;
      }
      default:
        return;
    }
  }

  private processInteractionEvent(
    state: SessionState,
    event: Record<string, unknown>,
    agentId: string | undefined,
  ): void {
    const interaction = event['interaction'] as
      | { id: string; kind: string; payload: unknown; tags: Record<string, string | number>; createdAt: number }
      | undefined;
    if (interaction === undefined) return;
    const kind = interaction.kind;
    if (kind !== 'approval' && kind !== 'question') return;
    const ownerId = agentId ?? String(interaction.tags['agentId'] ?? MAIN_AGENT_ID);
    const createdAt = new Date(interaction.createdAt).toISOString();
    if (event['type'] === 'interaction.requested') {
      if (kind === 'approval') {
        const payload = interaction.payload as Record<string, unknown>;
        const toolCallId =
          typeof payload['toolCallId'] === 'string'
            ? payload['toolCallId']
            : interaction.tags['toolCallId'];
        this.dispatch(
          state,
          'event.approval.requested',
          {
            approval_id: interaction.id,
            session_id: state.sessionId,
            agent_id: ownerId,
            tool_call_id: toolCallId,
            tool_name: payload['toolName'],
            action: payload['action'],
            display: payload['display'],
            tool_input_display: payload['toolInput'],
            created_at: createdAt,
          },
          false,
        );
      } else {
        const payload = interaction.payload as Record<string, unknown>;
        const turnId = interaction.tags['turnId'];
        const toolCallId = interaction.tags['toolCallId'];
        this.dispatch(
          state,
          'event.question.requested',
          {
            question_id: interaction.id,
            session_id: state.sessionId,
            agent_id: ownerId,
            turn_id: typeof turnId === 'number' ? turnId : undefined,
            tool_call_id: typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined,
            questions: payload['questions'] ?? [],
            created_at: createdAt,
          },
          false,
        );
      }
    } else {
      const response = event['response'];
      if (kind === 'approval') {
        const r = response as Record<string, unknown> | null;
        const cancelled =
          typeof r === 'object' && r !== null && r['cancelled'] === true;
        this.dispatch(
          state,
          'event.approval.resolved',
          {
            approval_id: interaction.id,
            decision: cancelled ? 'cancelled' : r?.['decision'],
            scope: r?.['scope'],
            feedback: r?.['feedback'],
            selected_label: r?.['selectedLabel'],
            resolved_at: new Date().toISOString(),
          },
          false,
        );
      } else if (response === null || (typeof response === 'object' && (response as { cancelled?: unknown }).cancelled === true)) {
        this.dispatch(
          state,
          'event.question.dismissed',
          { question_id: interaction.id, dismissed_at: new Date().toISOString() },
          false,
        );
      } else {
        const answers = (response as { answers?: unknown })?.answers ?? response;
        this.dispatch(
          state,
          'event.question.answered',
          { question_id: interaction.id, answers, resolved_at: new Date().toISOString() },
          false,
        );
      }
    }
    void this.routeOps(state, ownerId, event);
  }

  private async routeOps(state: SessionState, agentId: string | undefined, event: Record<string, unknown>): Promise<void> {
    if (agentId === undefined) return;
    const stream = await this.ensureTranscript(state, agentId);
    if (stream === undefined) return;
    const ops = stream.projector.map(event);
    this.dispatchTranscriptOps(state, agentId, ops);
  }

  private async mapAgentWireEvent(
    state: SessionState,
    agentId: string,
    event: Record<string, unknown>,
    track: AgentTrack | undefined,
  ): Promise<WireOut[]> {
    const type = event['type'] as string;
    const sessionId = state.sessionId;
    const base = { agentId, sessionId };
    switch (type) {
      case 'turn.started': {
        return [
          { type: 'agent.status.updated', payload: await this.agentStatusPayload(state, agentId, base) },
        ];
      }
      case 'turn.ended': {
        const outcome = event['outcome'] as
          | { type: 'done' }
          | { type: 'failed'; error?: unknown }
          | { type: 'aborted'; reason?: unknown }
          | { type: 'blocked'; cause?: { reason?: string; message?: string } };
        const reason =
          outcome.type === 'done' ? 'completed' : outcome.type === 'failed' || outcome.type === 'blocked' ? 'failed' : 'cancelled';
        const out: WireOut[] = [
          {
            type: 'turn.ended',
            payload: {
              turnId: event['turnId'],
              reason,
              error:
                outcome.type === 'failed'
                  ? messageOf(outcome.error)
                  : outcome.type === 'blocked'
                    ? (outcome.cause?.message ?? outcome.cause?.reason)
                    : undefined,
              ...base,
            },
          },
        ];
        const promptId = track?.promptByTurnId.get(event['turnId'] as number);
        if (promptId !== undefined) {
          if (outcome.type === 'aborted') {
            out.push({ type: 'prompt.aborted', payload: { promptId, ...base } });
          }
          out.push({
            type: 'prompt.completed',
            payload: {
              promptId,
              reason:
                outcome.type === 'done' ? 'completed' : outcome.type === 'failed' || outcome.type === 'blocked' ? 'failed' : 'aborted',
              ...base,
            },
          });
        }
        out.push({ type: 'agent.status.updated', payload: await this.agentStatusPayload(state, agentId, base) });
        return out;
      }
      case 'step.started':
        return [
          {
            type: 'turn.step.started',
            payload: { turnId: event['turnId'], step: event['step'], ...base },
          },
        ];
      case 'message.appended': {
        const entry = event['entry'] as
          | { message: { role: string }; meta?: { usage?: Record<string, number> } }
          | undefined;
        if (entry?.message.role !== 'assistant') return [];
        const stream = state.transcripts.get(agentId);
        return [
          {
            type: 'turn.step.completed',
            payload: {
              turnId: event['turnId'],
              step: (event['step'] as number | undefined) ?? stream?.projector.activeStepOrdinal,
              usage: entry.meta?.usage,
              ...base,
            },
          },
        ];
      }
      case 'llm.streaming.part': {
        const part = event['part'] as
          | { type: 'text'; text: string }
          | { type: 'think'; think: string; hidden?: boolean }
          | { type: 'function'; id: string; name: string; arguments: string | null }
          | { type: string };
        if (part.type === 'text') {
          const text = (part as { text: string }).text;
          if (text.length === 0) return [];
          return [
            { type: 'assistant.delta', payload: { turnId: event['turnId'], delta: text, ...base } },
          ];
        }
        if (part.type === 'think') {
          const think = part as { think: string; hidden?: boolean };
          if (think.hidden === true || think.think.length === 0) return [];
          return [
            { type: 'thinking.delta', payload: { turnId: event['turnId'], delta: think.think, ...base } },
          ];
        }
        if (part.type === 'function') {
          const call = part as { id: string; name: string; arguments: string | null };
          return [
            {
              type: 'tool.call.delta',
              payload: {
                turnId: event['turnId'],
                toolCallId: call.id,
                name: call.name,
                argumentsPart: call.arguments ?? '',
                ...base,
              },
            },
          ];
        }
        return [];
      }
      case 'tool.started': {
        const call = event['toolCall'] as { id: string; name: string; arguments: string | null };
        return [
          {
            type: 'tool.call.started',
            payload: {
              turnId: event['turnId'],
              toolCallId: call.id,
              name: call.name,
              args: parseToolArgs(call.arguments),
              ...base,
            },
          },
        ];
      }
      case 'tool.delta': {
        const update = event['update'] as { key: string; text: string; percent?: number };
        const knownKind = ['stdout', 'stderr', 'progress', 'status'].includes(update.key);
        return [
          {
            type: 'tool.progress',
            payload: {
              toolCallId: event['toolCallId'],
              update: {
                kind: knownKind ? update.key : 'custom',
                text: update.text,
                percent: update.percent,
                customKind: knownKind ? undefined : update.key,
              },
              ...base,
            },
          },
        ];
      }
      case 'tool.ended':
      case 'tool.async_ended': {
        const outcome = event['outcome'] as
          | { type: 'succeeded'; entry: { message: { content: unknown }; meta?: { isError?: true } } }
          | { type: 'failed'; error: unknown }
          | { type: 'aborted'; reason?: unknown }
          | { type: 'blocked'; cause: { message?: string } };
        const output =
          outcome.type === 'succeeded'
            ? outcome.entry.message.content
            : outcome.type === 'failed'
              ? outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
              : outcome.type === 'blocked'
                ? (outcome.cause.message ?? '')
                : undefined;
        return [
          {
            type: 'tool.result',
            payload: {
              toolCallId: event['toolCallId'],
              output,
              isError:
                outcome.type === 'failed' ||
                outcome.type === 'blocked' ||
                (outcome.type === 'succeeded' && outcome.entry.meta?.isError === true),
              ...base,
            },
          },
        ];
      }
      case 'prompt.submitted': {
        const entry = event['entry'] as
          | { message: { content: never[] }; meta?: { promptId?: string; userMessageId?: string; createdAt?: string } }
          | undefined;
        if (entry?.meta?.promptId === undefined) return [];
        return [
          {
            type: 'prompt.submitted',
            payload: {
              promptId: entry.meta.promptId,
              userMessageId: entry.meta.userMessageId,
              content: projectPromptContent(entry.message.content),
              createdAt: entry.meta.createdAt ?? new Date().toISOString(),
              ...base,
            },
          },
        ];
      }
      case 'prompt.steered':
        return [
          { type: 'prompt.steered', payload: { promptIds: event['promptIds'], ...base } },
        ];
      case 'hook.failed':
        return [
          {
            type: 'error',
            payload: {
              message: event['error'] instanceof Error ? (event['error'] as Error).message : String(event['error']),
              ...base,
            },
          },
        ];
      default:
        return [];
    }
  }

  private async agentStatusPayload(
    state: SessionState,
    agentId: string,
    base: { agentId: string; sessionId: string },
  ): Promise<Record<string, unknown>> {
    const root = this.opts.root;
    const sessionId = state.sessionId;
    const binding = agentFacade(root, AgentModelRef, sessionId, agentId)?.current.value;
    const catalog =
      binding?.alias === undefined || binding.alias === null || binding.alias === ''
        ? undefined
        : matchCatalogBinding(binding.alias, this.opts.bindings());
    const plan = agentFacade(root, PlanRef, sessionId, agentId);
    let planMode: boolean | undefined;
    if (plan !== undefined) {
      planMode = await plan.status().then((status) => status !== null, () => undefined);
    }
    return {
      model: catalog?.model.name ?? (binding?.alias === null ? undefined : binding?.alias),
      thinkingEffort: binding?.thinking ?? undefined,
      contextTokens: agentFacade(root, TokenCountingRef, sessionId, agentId)?.statusSize(),
      maxContextTokens: catalog?.model.maxInputSize ?? catalog?.model.maxContextSize,
      planMode,
      permission: agentFacade(root, PermissionRef, sessionId, agentId)?.mode(),
      ...base,
    };
  }

  private maybeEmitWorkChanged(state: SessionState): void {
    const status = state.handle.status();
    const work = {
      busy: sessionBusy(this.opts.root, state.handle),
      main_turn_active: status.mainTurnActive,
      pending_interaction: sessionPendingInteraction(this.opts.root, state.handle),
      last_turn_reason: status.lastTurnReason,
    };
    const key = JSON.stringify(work);
    if (key === state.lastWorkChanged) return;
    state.lastWorkChanged = key;
    this.dispatch(
      state,
      'event.session.work_changed',
      { ...work, agentId: MAIN_AGENT_ID, sessionId: state.sessionId },
      false,
    );
  }

  private dispatchSessionEvent(sessionId: string, wire: WireOut): void {
    const state = this.ensureState(sessionId);
    if (state === undefined) return;
    state.queue = state.queue
      .then(() => {
        this.dispatch(state, wire.type, wire.payload, false);
      })
      .catch(() => {});
  }

  private dispatchGlobal(wire: WireOut): void {
    if (this.closed) return;
    this.globalState ??= {
      journal: new EventJournal(this.opts.maxBufferSize),
      queue: Promise.resolve(),
    };
    const global = this.globalState;
    global.queue = global.queue
      .then(() => {
        const seq = global.journal.nextSeq();
        const envelope: EventEnvelope = {
          type: wire.type,
          seq,
          epoch: global.journal.epoch,
          session_id: GLOBAL_SESSION_ID,
          timestamp: new Date().toISOString(),
          payload: wire.payload,
        };
        global.journal.append(seq, envelope);
        const recipients = new Set<BroadcastTarget>(this.globalTargets);
        for (const state of this.sessions.values()) {
          for (const target of state.targets.keys()) recipients.add(target);
        }
        for (const target of recipients) {
          try {
            target.send(envelope, 'immediate');
          } catch {
          }
        }
      })
      .catch(() => {});
  }

  private dispatch(state: SessionState, type: string, payload: Record<string, unknown>, volatile: boolean): void {
    const trackDeltas = payload['agentId'] === MAIN_AGENT_ID;
    let envelope: EventEnvelope;
    if (volatile) {
      const annotation = trackDeltas ? state.tracker.apply({ type, ...payload }) : {};
      envelope = {
        type,
        seq: state.journal.seq,
        epoch: state.journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
        session_id: state.sessionId,
        timestamp: new Date().toISOString(),
        payload,
      };
    } else {
      const seq = state.journal.nextSeq();
      envelope = {
        type,
        seq,
        epoch: state.journal.epoch,
        session_id: state.sessionId,
        timestamp: new Date().toISOString(),
        payload,
      };
      state.journal.append(seq, envelope);
      if (trackDeltas) state.tracker.apply({ type, ...payload });
    }

    if (isGlobalEvent(type)) {
      const recipients = new Set<BroadcastTarget>(this.globalTargets);
      for (const target of state.targets.keys()) recipients.add(target);
      for (const target of recipients) {
        try {
          target.send(envelope, 'immediate');
        } catch {
        }
      }
      return;
    }
    for (const [target, sub] of state.targets) {
      if (!matchesAgentFilter(envelope, sub.agentFilter)) continue;
      if (suppressedByTranscript(envelope, sub.transcriptGrades)) continue;
      try {
        target.send(envelope);
      } catch {
      }
    }
  }
}

function isGlobalEvent(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.') ||
    type.startsWith('event.model_catalog.') ||
    type.startsWith('event.plugin.') ||
    type.startsWith('event.capability.')
  );
}

function isAgentLifecycleEvent(type: string): boolean {
  return type === 'agent.created' || type === 'agent.disposed';
}

function isInteractionEvent(type: string): boolean {
  return type.startsWith('event.approval.') || type.startsWith('event.question.');
}

function matchesAgentFilter(envelope: EventEnvelope, filter: AgentFilter): boolean {
  if (filter === undefined) return true;
  if (isGlobalEvent(envelope.type)) return true;
  if (isAgentLifecycleEvent(envelope.type)) return true;
  if (isInteractionEvent(envelope.type)) return true;
  const payload = envelope.payload;
  const agentId =
    typeof payload === 'object' && payload !== null
      ? (payload as { agentId?: unknown }).agentId
      : undefined;
  if (typeof agentId !== 'string') return true;
  return filter.has(agentId);
}

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

function withoutAgentId(event: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, agentId: _agentId, sessionId: _sessionId, time: _time, ...rest } = event;
  return rest;
}

function taskRecordToInfo(record: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: record['taskId'],
    kind: record['toolName'],
    description: record['description'],
    command: record['description'],
    status: record['status'],
    startedAt: record['startedAt'],
    endedAt: record['endedAt'],
    stopReason: record['stopReason'],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceWireOf(event: unknown): Record<string, unknown> | undefined {
  const workspace = (event as { workspace?: unknown }).workspace;
  if (typeof workspace !== 'object' || workspace === null) return undefined;
  const entry = workspace as { id?: unknown; root?: unknown; name?: unknown; lastOpenedAt?: unknown };
  if (typeof entry.id !== 'string' || typeof entry.root !== 'string') return undefined;
  return {
    workspace: {
      id: entry.id,
      root: entry.root,
      name: typeof entry.name === 'string' ? entry.name : '',
      last_opened_at:
        typeof entry.lastOpenedAt === 'number' ? new Date(entry.lastOpenedAt).toISOString() : undefined,
    },
    agentId: MAIN_AGENT_ID,
  };
}

export type { BufferedSinceResult, EventEnvelope, ResyncReason, SessionCursor };
