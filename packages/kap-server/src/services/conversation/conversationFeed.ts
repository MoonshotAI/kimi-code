import {
  CompactionCancelled,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  IAgentBlobService,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  ILogService,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  PromptCompleted,
  SubagentSpawned,
  type DurableAgentRuntimeParticipant,
  type IAgentScopeHandle,
  type IDisposable,
  type ToolUpdate,
} from '@moonshot-ai/agent-core-v2';
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStepInterrupted,
  TurnStepRetrying,
  TurnStepStreamReset,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { AgentErrorEvent } from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';
import { WarningIssued } from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import { ToolProgress } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { isMediaPart, type MediaPart } from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  ConversationItem,
  ConversationMessage,
  ConversationTurn,
  ConversationTurnHeader,
  ConversationTurnsPage,
  Notice,
  TurnsFailedMessage,
  TurnsMessage,
} from '../../protocol/conversation';
import {
  applyConversationRecord,
  createConversationState,
  settleOrphanTurns,
  undoConversationTurns,
  type ConversationFork,
  type ConversationState,
  type FoldItem,
  type FoldReasoning,
  type FoldText,
  type FoldToolCall,
  type FoldTurn,
  type LiveToolFields,
  type LiveToolProgress,
  type RunningWork,
} from './conversationFold';
import {
  COMPACTION_CANCELLED_NOTICE,
  errorNotice,
  keepMediaUrl,
  mediaPartsOf,
  mediaUrl,
  presentHeader,
  presentItem,
  presentTurn,
  warningNotice,
  type MediaResolver,
} from './conversationProjection';

type Unframed<T> = T extends unknown ? Omit<T, 'session_id' | 'agent_id' | 'event_created_at'> : never;

export type ConversationEvent =
  | { readonly type: 'reset' }
  | Unframed<Exclude<ConversationMessage, TurnsMessage | TurnsFailedMessage>>;

export type ConversationListener = (event: ConversationEvent) => void;

interface LiveItem {
  readonly turnId: string;
  readonly stepId: string;
  item: FoldText | FoldReasoning | FoldToolCall;
}

interface LiveTool {
  readonly turnId: string;
  readonly fields: LiveToolFields;
}

const RECORD_EVENTS = [
  TurnPrompt,
  ContextAppendMessage,
  ContextAppendLoopEvent,
  TurnSteer,
  TurnCancel,
  TurnStepInterrupted,
  TurnStepRetrying,
  TurnEnded,
  PromptCompleted,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  SubagentSpawned,
  FullCompactionBegin,
  ContextApplyCompaction,
  FullCompactionComplete,
  FullCompactionCancel,
  ContextClear,
];

const BLOBREF_PREFIX = 'blobref:';
const PAGE_BYTES = 1024 * 1024;
const PAGE_ENVELOPE_BYTES = 4 * 1024;

export class ConversationFeed implements IDisposable {
  private state: ConversationState;
  private sent: readonly FoldTurn[] = [];
  private started = false;
  private replay: ReplayGate | undefined;
  private beforeReplay: ConversationState | undefined;
  private flushQueued = false;
  private disposed = false;
  private firstReplay: ((ok: boolean) => void) | undefined;
  private readonly live = new Map<string, LiveItem>();
  private readonly tools = new Map<string, LiveTool>();
  private readonly listeners = new Set<ConversationListener>();
  private readonly disposables: IDisposable[] = [];
  readonly ready: Promise<ConversationFeed>;

  constructor(
    private readonly handle: IAgentScopeHandle,
    fork?: ConversationFork,
  ) {
    this.state = createConversationState(handle.id, fork);
    this.ready = this.start().then(
      () => this,
      (error: unknown) => {
        this.dispose();
        throw error;
      },
    );
  }

  turns(): readonly FoldTurn[] {
    return this.state.turns;
  }

  subscribe(listener: ConversationListener): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async page(before: number | undefined, limit: number): Promise<ConversationTurnsPage> {
    while (this.replay !== undefined) await this.replay.done;
    const turns = this.state.turns;
    const end = before === undefined ? turns.length : turns.findIndex((turn) => turn.ordinal >= before);
    const stop = end === -1 ? turns.length : end;
    const start = Math.max(0, stop - limit);
    const selected = turns.slice(start, stop).map((turn) => ({ turn, items: this.itemsOf(turn) }));
    const page: ConversationTurn[] = [];
    let bytes = 0;
    for (const { turn, items } of selected.toReversed()) {
      const remaining = PAGE_BYTES - PAGE_ENVELOPE_BYTES - bytes;
      if (page.length > 0 && turnBytes(presentTurn(turn, items)) > remaining) break;
      const presented = presentTurn(turn, items, await this.loadMedia(items));
      const size = turnBytes(presented);
      if (page.length > 0 && size > remaining) break;
      bytes += size;
      page.unshift(presented);
    }
    return { turns: page, has_more: start > 0 || page.length < selected.length };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.listeners.clear();
    this.live.clear();
    this.tools.clear();
    this.finishReplay();
  }

  private async start(): Promise<void> {
    const bus = this.handle.accessor.get(IEventBus);
    this.disposables.push(
      bus.subscribe(AssistantDelta, (event) => {
        this.onTextDelta('assistant_message', event.turnId, event.block, event.delta);
      }),
      bus.subscribe(ThinkingDelta, (event) => {
        this.onTextDelta('reasoning', event.turnId, event.block, event.delta);
      }),
      bus.subscribe(ToolCallDelta, (event) => {
        this.onToolCallDelta(event.turnId, event.toolCallId, event.name, event.argumentsPart);
      }),
      bus.subscribe(ToolProgress, (event) => {
        this.onToolProgress(event.toolCallId, event.update);
      }),
      bus.subscribe(TurnStepStreamReset, (event) => {
        this.flushPending();
        this.dropLive((entry) => entry.stepId === event.stepId);
      }),
      bus.subscribe(WarningIssued, (event) => {
        this.notify(warningNotice(event.message, event.code));
      }),
      bus.subscribe(AgentErrorEvent, (event) => {
        this.notify(errorNotice(event));
      }),
      bus.subscribe(CompactionCancelled, () => {
        this.notify(COMPACTION_CANCELLED_NOTICE);
      }),
    );
    const dispatcher = this.handle.accessor.get(IEventDispatcher);
    const participant: DurableAgentRuntimeParticipant<ConversationState> = {
      id: 'kap.conversation',
      events: RECORD_EVENTS,
      undoable: true,
      transition: (draft, event) => {
        applyConversationRecord(draft, event.serialize());
      },
      onUndo: (draft, count) => undoConversationTurns(draft, count),
      onWillReplay: () => {
        this.willReplay();
      },
      onDidReplay: (state, { ok }) => this.didReplay(state, ok),
      getState: () => this.state,
      commit: (next) => {
        this.commit(next);
      },
    };
    if (dispatcher.restorePhase === 'new') {
      await new Promise<void>((resolve, reject) => {
        this.firstReplay = (ok) => {
          if (ok) resolve();
          else reject(new Error(`agent ${this.handle.id} failed to restore its conversation`));
        };
        this.disposables.push(dispatcher.attach(participant), {
          dispose: () => {
            reject(new Error(`agent ${this.handle.id} closed before its conversation was restored`));
          },
        });
      });
    } else {
      this.disposables.push(await dispatcher.attachLate(participant));
    }
    this.sent = this.state.turns;
    this.started = true;
  }

  private willReplay(): void {
    this.replay ??= replayGate();
    this.beforeReplay ??= this.state;
    this.dropLive(() => true);
    this.tools.clear();
  }

  private didReplay(replayed: ConversationState, ok: boolean): ConversationState {
    const kept = ok ? undefined : this.beforeReplay;
    this.beforeReplay = undefined;
    this.state = settleOrphanTurns(kept ?? replayed, this.runningWork());
    if (kept === undefined) this.sent = this.state.turns;
    this.finishReplay();
    if (this.started) {
      if (kept === undefined) this.emit({ type: 'reset' });
      else this.flush();
    }
    this.firstReplay?.(ok);
    this.firstReplay = undefined;
    return this.state;
  }

  private finishReplay(): void {
    this.replay?.finish();
    this.replay = undefined;
  }

  private runningWork(): RunningWork {
    const loop = this.handle.accessor.get(IAgentLoopService).snapshot();
    return { turnNumber: loop.state === 'running' ? loop.activeTurnId : undefined };
  }

  private commit(next: ConversationState): void {
    this.state = next;
    if (!this.started || this.replay !== undefined || this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushPending();
    });
  }

  private flushPending(): void {
    if (this.flushQueued) this.flush();
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.disposed || this.replay !== undefined) return;
    const previous = this.sent;
    const next = this.state.turns;
    if (previous === next) return;
    this.sent = next;
    const nextById = new Map(next.map((turn) => [turn.id, turn]));
    const removed = new Set(previous.filter((turn) => !nextById.has(turn.id)).map((turn) => turn.id));
    const shrunk = previous.some((turn) => {
      const after = nextById.get(turn.id);
      return after !== undefined && (after.items.length < turn.items.length || after.steps.length < turn.steps.length);
    });
    if (removed.size > 0 || shrunk) {
      this.dropLive((entry) => removed.has(entry.turnId), false);
      for (const [toolCallId, tool] of this.tools) {
        if (removed.has(tool.turnId)) this.tools.delete(toolCallId);
      }
      this.emit({ type: 'reset' });
      return;
    }
    const previousById = new Map(previous.map((turn) => [turn.id, turn]));
    for (const turn of next) {
      const before = previousById.get(turn.id);
      if (before !== turn) this.emitTurnChanges(before, turn);
    }
  }

  private emitTurnChanges(before: FoldTurn | undefined, turn: FoldTurn): void {
    const header = presentHeader(turn);
    const previous = before === undefined ? undefined : presentHeader(before);
    if (previous === undefined || (previous.status === 'ended' && header.status === 'running')) {
      this.emit({ type: 'turn.started', turn: header });
    }
    this.emitItemChanges(before, turn);
    this.dropLive((entry) => entry.turnId === turn.id && !liveStepOpen(turn, entry.stepId));
    if (previous !== undefined) this.emitTurnUpdates(previous, header);
    if (header.status === 'ended' && (previous?.status !== 'ended' || !sameJson(previous, header))) {
      this.emit({ type: 'turn.ended', turn: header });
    }
  }

  private emitTurnUpdates(previous: ConversationTurnHeader, header: ConversationTurnHeader): void {
    const earlier = new Map(previous.steps.map((step) => [step.index, step]));
    const steps = header.steps.filter((step) => !sameJson(earlier.get(step.index), step));
    for (const step of steps) this.emit({ type: 'turn.updated', turn_id: header.turn_id, step, retry: header.retry });
    if (steps.length === 0 && header.status === 'running' && !sameJson(previous.retry, header.retry)) {
      this.emit({ type: 'turn.updated', turn_id: header.turn_id, retry: header.retry });
    }
  }

  private emitItemChanges(before: FoldTurn | undefined, turn: FoldTurn): void {
    const previous = new Map(before?.items.map((item) => [item.id, item]));
    for (const item of turn.items) {
      const old = previous.get(item.id);
      if (old === item) continue;
      const live = this.live.get(item.id);
      this.live.delete(item.id);
      const earlier = live?.item ?? (old === undefined ? undefined : this.withLiveFields(old));
      this.emitItemChange(turn.id, earlier === undefined ? undefined : presentItem(earlier), presentItem(this.withLiveFields(item)));
      if (item.type === 'tool_call' && item.status === 'ended') this.tools.delete(item.id);
    }
  }

  private emitItemChange(turnId: string, before: ConversationItem | undefined, after: ConversationItem): void {
    if (after.status === 'ended') {
      if (before?.status !== 'ended' || !sameJson(before, after)) this.emit({ type: 'item.ended', turn_id: turnId, item: after });
      return;
    }
    if (before === undefined) {
      this.emit({ type: 'item.started', turn_id: turnId, item: after });
      return;
    }
    if (before.type !== 'tool_call' || after.type !== 'tool_call') return;
    const set = changedFields(before, after);
    if (Object.keys(set).length > 0) this.emit({ type: 'item.updated', turn_id: turnId, item_id: after.item_id, set });
  }

  private onTextDelta(
    type: 'assistant_message' | 'reasoning',
    turnNumber: number,
    block: number | undefined,
    delta: string,
  ): void {
    if (block === undefined || delta.length === 0 || this.replay !== undefined) return;
    this.flushPending();
    const target = this.liveTarget(turnNumber);
    if (target === undefined) return;
    const itemId = `${target.stepId}:${block}`;
    const entry = this.live.get(itemId);
    if (entry !== undefined) {
      if (entry.item.type === 'tool_call' || entry.item.type !== type) return;
      entry.item = { ...entry.item, text: entry.item.text + delta };
      this.emit({ type: 'item.delta', turn_id: target.turn.id, item_id: itemId, field: 'text', delta });
      return;
    }
    if (target.turn.items.some((item) => item.id === itemId)) return;
    this.endLiveBlocks(target.stepId);
    const now = Date.now();
    const base = { id: itemId, stepIndex: target.stepIndex, createdAt: now, status: 'running', text: delta } as const;
    const item: FoldText | FoldReasoning = type === 'reasoning' ? { ...base, type, startedAt: now } : { ...base, type };
    this.live.set(itemId, { turnId: target.turn.id, stepId: target.stepId, item });
    this.emit({ type: 'item.started', turn_id: target.turn.id, item: presentItem(item) });
  }

  private onToolCallDelta(
    turnNumber: number,
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    if (this.replay !== undefined) return;
    this.flushPending();
    const entry = this.live.get(toolCallId);
    if (entry?.item.type === 'tool_call') {
      if (argumentsPart === undefined || argumentsPart.length === 0) return;
      entry.item = { ...entry.item, live: { inputText: (entry.item.live?.inputText ?? '') + argumentsPart } };
      this.emit({ type: 'item.delta', turn_id: entry.turnId, item_id: toolCallId, field: 'input_text', delta: argumentsPart });
      return;
    }
    if (name === undefined || entry !== undefined) return;
    const target = this.liveTarget(turnNumber);
    if (target === undefined || target.turn.items.some((item) => item.id === toolCallId)) return;
    this.endLiveBlocks(target.stepId);
    const now = Date.now();
    const item: FoldToolCall = {
      type: 'tool_call',
      id: toolCallId,
      stepIndex: target.stepIndex,
      createdAt: now,
      startedAt: now,
      name,
      status: 'running',
      streaming: true,
      live: { inputText: argumentsPart ?? '' },
    };
    this.live.set(toolCallId, { turnId: target.turn.id, stepId: target.stepId, item });
    this.emit({ type: 'item.started', turn_id: target.turn.id, item: presentItem(item) });
  }

  private onToolProgress(toolCallId: string, update: ToolUpdate): void {
    if (this.replay !== undefined) return;
    this.flushPending();
    const target = this.runningTool(toolCallId);
    if (target === undefined) return;
    const fields = this.tools.get(toolCallId)?.fields ?? {};
    if ((update.kind === 'stdout' || update.kind === 'stderr') && update.replace !== true) {
      const text = update.text ?? '';
      if (text.length === 0) return;
      this.tools.set(toolCallId, { turnId: target.turn.id, fields: { ...fields, output: (fields.output ?? '') + text } });
      this.emit({ type: 'item.delta', turn_id: target.turn.id, item_id: toolCallId, field: 'output', delta: text });
      return;
    }
    const next: LiveToolFields = update.kind === 'stdout' || update.kind === 'stderr'
      ? { ...fields, output: update.text ?? '' }
      : { ...fields, progress: nextProgress(fields.progress, update) };
    const before = presentItem(this.withLiveFields(target.item));
    this.tools.set(toolCallId, { turnId: target.turn.id, fields: next });
    this.emitItemChange(target.turn.id, before, presentItem(this.withLiveFields(target.item)));
  }

  private notify(notice: Notice): void {
    this.flushPending();
    this.emit({ type: 'notice', ...notice });
  }

  private endLiveBlocks(stepId: string): void {
    const now = Date.now();
    for (const entry of this.live.values()) {
      const item = entry.item;
      if (entry.stepId !== stepId || item.status !== 'running' || item.type === 'tool_call') continue;
      entry.item = item.type === 'reasoning'
        ? { ...item, status: 'ended', durationMs: now - item.startedAt }
        : { ...item, status: 'ended' };
      this.emit({ type: 'item.ended', turn_id: entry.turnId, item: presentItem(entry.item) });
    }
  }

  private liveTarget(turnNumber: number): { turn: FoldTurn; stepId: string; stepIndex: number } | undefined {
    const turn = this.state.turns.findLast((candidate) => candidate.turnNumber === turnNumber && candidate.status === 'running');
    const step = turn?.steps.at(-1);
    if (turn === undefined || step === undefined || step.endedAt !== undefined) return undefined;
    return { turn, stepId: step.id, stepIndex: step.index };
  }

  private runningTool(toolCallId: string): { turn: FoldTurn; item: FoldToolCall } | undefined {
    const turnId = this.state.toolTurns[toolCallId];
    const turn = turnId === undefined ? undefined : this.state.turns.findLast((candidate) => candidate.id === turnId);
    const item = turn?.items.find((candidate) => candidate.id === toolCallId);
    if (turn === undefined || item?.type !== 'tool_call' || item.status !== 'running') return undefined;
    return { turn, item };
  }

  private withLiveFields(item: FoldItem): FoldItem {
    if (item.type !== 'tool_call' || item.status !== 'running') return item;
    const tool = this.tools.get(item.id);
    return tool === undefined ? item : { ...item, live: tool.fields };
  }

  private itemsOf(turn: FoldTurn): FoldItem[] {
    const live = [...this.live.values()].filter((entry) => entry.turnId === turn.id).map((entry) => entry.item);
    return [...turn.items.map((item) => this.withLiveFields(item)), ...live];
  }

  private dropLive(match: (entry: LiveItem) => boolean, announce = true): void {
    for (const [itemId, entry] of this.live) {
      if (!match(entry)) continue;
      this.live.delete(itemId);
      if (announce) this.emit({ type: 'item.removed', turn_id: entry.turnId, item_id: itemId });
    }
  }

  private async loadMedia(items: readonly FoldItem[]): Promise<MediaResolver> {
    const refs = new Map<string, MediaPart>();
    for (const part of items.flatMap((item) => mediaPartsOf(item))) {
      const url = mediaUrl(part);
      if (url?.startsWith(BLOBREF_PREFIX) === true) refs.set(url, part);
    }
    if (refs.size === 0) return keepMediaUrl;
    const loaded = new Map<string, string>();
    await Promise.all([...refs].map(async ([ref, part]) => {
      const url = await this.loadBlob(part);
      if (url !== undefined) loaded.set(ref, url);
    }));
    return (url) => loaded.get(url) ?? url;
  }

  private async loadBlob(part: MediaPart): Promise<string | undefined> {
    try {
      const [loaded] = await this.handle.accessor.get(IAgentBlobService).loadParts([part]);
      return loaded === undefined || !isMediaPart(loaded) ? undefined : mediaUrl(loaded);
    } catch (error) {
      this.handle.accessor.get(ILogService).warn('conversation media failed to load; serving its reference', {
        agentId: this.handle.id,
        error,
      });
      return undefined;
    }
  }

  private emit(event: ConversationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
}

interface ReplayGate {
  readonly done: Promise<void>;
  readonly finish: () => void;
}

function replayGate(): ReplayGate {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

function turnBytes(turn: ConversationTurn): number {
  return Buffer.byteLength(JSON.stringify(turn)) + 1;
}

function liveStepOpen(turn: FoldTurn, stepId: string): boolean {
  if (turn.status !== 'running') return false;
  const step = turn.steps.findLast((candidate) => candidate.id === stepId);
  return step !== undefined && step.endedAt === undefined;
}

function nextProgress(progress: LiveToolProgress | undefined, update: ToolUpdate): LiveToolProgress {
  switch (update.kind) {
    case 'progress':
      return { ...progress, percent: update.percent ?? progress?.percent, status: update.text ?? progress?.status };
    case 'status':
      return { ...progress, status: update.text ?? progress?.status };
    default:
      return { ...progress, customKind: update.customKind, customData: update.customData };
  }
}

function changedFields<T extends object>(before: T, after: T): Partial<T> {
  const set: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] !== undefined && !sameJson(before[key], after[key])) set[key] = after[key];
  }
  return set;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
