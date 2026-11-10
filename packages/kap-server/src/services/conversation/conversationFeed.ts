import {
  CompactionCancelled,
  Error2,
  ErrorCodes,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  IAgentBlobService,
  IAgentConversationUndoService,
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
import { isMediaPart } from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  AssistantMessageItem,
  ConversationItem,
  ConversationMessage,
  ConversationTurn,
  ConversationTurnHeader,
  ConversationTurnsPage,
  Media,
  Notice,
  ReasoningItem,
  ToolCallItem,
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
  type RunningWork,
} from './conversationFold';
import { isoTime, mediaPartOf, mediaTypeOf, mediaUrlOf } from './conversationItems';

const UNDOABLE_ORIGINS: ReadonlySet<string> = new Set(['user', 'skill', 'plugin_command']);

type Unframed<T> = T extends unknown ? Omit<T, 'session_id' | 'agent_id' | 'event_created_at'> : never;

export type ConversationEvent = Unframed<Exclude<ConversationMessage, TurnsMessage | TurnsFailedMessage>>;

export type ConversationListener = (event: ConversationEvent) => void;

interface LiveItem {
  readonly turnId: string;
  readonly stepId: string;
  item: AssistantMessageItem | ReasoningItem | ToolCallItem;
}

type LiveToolFields = Pick<ToolCallItem, 'output' | 'progress'>;

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

const COMPACTION_CANCELLED_NOTICE: Notice = {
  level: 'warning',
  title: 'Context compaction did not finish',
  code: 'compaction.cancelled',
};

export class ConversationFeed implements IDisposable {
  private state: ConversationState;
  private sent: readonly ConversationTurn[] = [];
  private started = false;
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
    this.state = createConversationState(handle.id, fork, process.env['KIMI_CODE_DEBUG'] === '1');
    this.ready = this.start().then(
      () => this,
      (error: unknown) => {
        this.dispose();
        throw error;
      },
    );
  }

  turns(): readonly ConversationTurn[] {
    return this.state.turns;
  }

  async undo(turnId: string): Promise<readonly string[]> {
    const turns = this.state.turns;
    const index = turns.findIndex((turn) => turn.turn_id === turnId);
    if (index === -1) throw new Error2(ErrorCodes.TURN_NOT_FOUND, `turn not found: ${turnId}`);
    const removed = turns.slice(index).map((turn) => turn.turn_id);
    const gone = new Set(removed);
    const anchors = this.state.anchors.filter((anchor) => gone.has(anchor.turnId)).length;
    if (!opensWithUserInput(turns[index]!) || anchors === 0) {
      throw new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, `turn ${turnId} does not open with user input`);
    }
    await this.handle.accessor.get(IAgentConversationUndoService).undo(anchors);
    return removed;
  }

  subscribe(listener: ConversationListener): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async page(before: number | undefined, limit: number): Promise<ConversationTurnsPage> {
    const turns = (this.beforeReplay ?? this.state).turns;
    const end = before === undefined ? turns.length : turns.findIndex((turn) => turn.ordinal >= before);
    const stop = end === -1 ? turns.length : end;
    const start = Math.max(0, stop - limit);
    const selected = turns.slice(start, stop).map((turn) => this.withLive(turn));
    const page: ConversationTurn[] = [];
    let bytes = 0;
    for (const turn of selected.toReversed()) {
      const remaining = PAGE_BYTES - PAGE_ENVELOPE_BYTES - bytes;
      if (page.length > 0 && turnBytes(turn) > remaining) break;
      const loaded = await this.withLoadedMedia(turn);
      const size = turnBytes(loaded);
      if (page.length > 0 && size > remaining) break;
      bytes += size;
      page.unshift(loaded);
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
        this.notify({ level: 'warning', title: event.message, code: event.code });
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
      onDidReplay: (state, { ok }) => {
        this.didReplay(state, ok);
      },
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
    this.beforeReplay ??= this.state;
    this.dropLive(() => true);
    this.tools.clear();
  }

  private didReplay(replayed: ConversationState, ok: boolean): void {
    const kept = ok ? undefined : this.beforeReplay;
    this.beforeReplay = undefined;
    this.state = settleOrphanTurns(kept ?? replayed, this.runningWork());
    if (this.started) this.flush();
    this.firstReplay?.(ok);
    this.firstReplay = undefined;
  }

  private runningWork(): RunningWork {
    const loop = this.handle.accessor.get(IAgentLoopService).snapshot();
    return { turnNumber: loop.state === 'running' ? loop.activeTurnId : undefined };
  }

  private commit(next: ConversationState): void {
    this.state = next;
    if (!this.started || this.beforeReplay !== undefined || this.flushQueued) return;
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
    if (this.disposed || this.beforeReplay !== undefined) return;
    const previous = this.sent;
    const next = this.state.turns;
    if (previous === next) return;
    this.sent = next;
    const nextById = new Map(next.map((turn) => [turn.turn_id, turn]));
    const removed = previous.filter((turn) => !nextById.has(turn.turn_id)).map((turn) => turn.turn_id);
    if (removed.length > 0) {
      const gone = new Set(removed);
      this.dropLive((entry) => gone.has(entry.turnId), false);
      for (const [toolCallId, tool] of this.tools) {
        if (gone.has(tool.turnId)) this.tools.delete(toolCallId);
      }
      this.emit({ type: 'turns.removed', turn_ids: removed });
    }
    const previousById = new Map(previous.map((turn) => [turn.turn_id, turn]));
    for (const turn of next) {
      const before = previousById.get(turn.turn_id);
      if (before !== turn) this.emitTurnChanges(before, turn);
    }
  }

  private emitTurnChanges(before: ConversationTurn | undefined, turn: ConversationTurn): void {
    const header = headerOf(turn);
    const previous = before === undefined ? undefined : headerOf(before);
    if (previous === undefined || (previous.status === 'ended' && header.status === 'running')) {
      this.emit({ type: 'turn.started', turn: header });
    }
    this.emitItemChanges(before, turn);
    this.dropLive((entry) => entry.turnId === turn.turn_id && !this.liveStepOpen(turn, entry.stepId));
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

  private emitItemChanges(before: ConversationTurn | undefined, turn: ConversationTurn): void {
    const previous = new Map(before?.items.map((item) => [item.item_id, item]));
    for (const item of turn.items) {
      const old = previous.get(item.item_id);
      if (old === item) continue;
      const live = this.live.get(item.item_id);
      this.live.delete(item.item_id);
      const earlier = live?.item ?? (old === undefined ? undefined : this.withLiveFields(old));
      this.emitItemChange(turn.turn_id, earlier, this.withLiveFields(item));
      if (item.type === 'tool_call' && item.status === 'ended') this.tools.delete(item.item_id);
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
    if (block === undefined || delta.length === 0 || this.beforeReplay !== undefined) return;
    this.flushPending();
    const target = this.liveTarget(turnNumber);
    if (target === undefined) return;
    const itemId = `${target.stepId}:${block}`;
    const entry = this.live.get(itemId);
    if (entry !== undefined) {
      if (entry.item.type === 'tool_call' || entry.item.type !== type) return;
      entry.item = { ...entry.item, text: entry.item.text + delta };
      this.emit({ type: 'item.delta', turn_id: target.turn.turn_id, item_id: itemId, field: 'text', delta });
      return;
    }
    if (target.turn.items.some((item) => item.item_id === itemId)) return;
    const now = Date.now();
    const base = { item_id: itemId, step_index: target.stepIndex, status: 'running', created_at: isoTime(now), text: delta } as const;
    const item: AssistantMessageItem | ReasoningItem = type === 'reasoning'
      ? { type, ...base, started_at: isoTime(now) }
      : { type, ...base };
    this.live.set(itemId, { turnId: target.turn.turn_id, stepId: target.stepId, item });
    this.emit({ type: 'item.started', turn_id: target.turn.turn_id, item });
  }

  private onToolCallDelta(
    turnNumber: number,
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | undefined,
  ): void {
    if (this.beforeReplay !== undefined) return;
    this.flushPending();
    const entry = this.live.get(toolCallId);
    if (entry?.item.type === 'tool_call') {
      if (argumentsPart === undefined || argumentsPart.length === 0) return;
      entry.item = { ...entry.item, input_text: (entry.item.input_text ?? '') + argumentsPart };
      this.emit({ type: 'item.delta', turn_id: entry.turnId, item_id: toolCallId, field: 'input_text', delta: argumentsPart });
      return;
    }
    if (name === undefined || entry !== undefined) return;
    const target = this.liveTarget(turnNumber);
    if (target === undefined || target.turn.items.some((item) => item.item_id === toolCallId)) return;
    const now = Date.now();
    const item: ToolCallItem = {
      type: 'tool_call',
      item_id: toolCallId,
      step_index: target.stepIndex,
      status: 'running',
      created_at: isoTime(now),
      name,
      stage: 'input',
      input_text: argumentsPart ?? '',
      started_at: isoTime(now),
    };
    this.live.set(toolCallId, { turnId: target.turn.turn_id, stepId: target.stepId, item });
    this.emit({ type: 'item.started', turn_id: target.turn.turn_id, item });
  }

  private onToolProgress(toolCallId: string, update: ToolUpdate): void {
    if (this.beforeReplay !== undefined) return;
    this.flushPending();
    const target = this.runningTool(toolCallId);
    if (target === undefined) return;
    const fields = this.tools.get(toolCallId)?.fields ?? {};
    if ((update.kind === 'stdout' || update.kind === 'stderr') && update.replace !== true) {
      const text = update.text ?? '';
      if (text.length === 0) return;
      this.tools.set(toolCallId, { turnId: target.turn.turn_id, fields: { ...fields, output: (fields.output ?? '') + text } });
      this.emit({ type: 'item.delta', turn_id: target.turn.turn_id, item_id: toolCallId, field: 'output', delta: text });
      return;
    }
    const next: LiveToolFields = update.kind === 'stdout' || update.kind === 'stderr'
      ? { ...fields, output: update.text ?? '' }
      : { ...fields, progress: nextProgress(fields.progress, update) };
    const before = this.withLiveFields(target.item);
    this.tools.set(toolCallId, { turnId: target.turn.turn_id, fields: next });
    this.emitItemChange(target.turn.turn_id, before, this.withLiveFields(target.item));
  }

  private notify(notice: Notice): void {
    this.flushPending();
    this.emit({ type: 'notice', ...notice });
  }

  private liveTarget(turnNumber: number): { turn: ConversationTurn; stepId: string; stepIndex: number } | undefined {
    const turn = this.state.turns.findLast((candidate) => candidate.turn_number === turnNumber && candidate.status === 'running');
    const step = turn === undefined ? undefined : this.state.steps[turn.turn_id]?.at(-1);
    if (turn === undefined || step === undefined || step.ended) return undefined;
    return { turn, stepId: step.id, stepIndex: step.index };
  }

  private liveStepOpen(turn: ConversationTurn, stepId: string): boolean {
    if (turn.status !== 'running') return false;
    const step = this.state.steps[turn.turn_id]?.findLast((candidate) => candidate.id === stepId);
    return step !== undefined && !step.ended;
  }

  private runningTool(toolCallId: string): { turn: ConversationTurn; item: ToolCallItem } | undefined {
    const turnId = this.state.tools[toolCallId]?.turnId;
    const turn = turnId === undefined ? undefined : this.state.turns.findLast((candidate) => candidate.turn_id === turnId);
    const item = turn?.items.find((candidate) => candidate.item_id === toolCallId);
    if (turn === undefined || item?.type !== 'tool_call' || item.status !== 'running') return undefined;
    return { turn, item };
  }

  private withLiveFields(item: ConversationItem): ConversationItem {
    if (item.type !== 'tool_call' || item.status !== 'running') return item;
    const tool = this.tools.get(item.item_id);
    return tool === undefined ? item : { ...item, ...tool.fields };
  }

  private withLive(turn: ConversationTurn): ConversationTurn {
    const live = [...this.live.values()].filter((entry) => entry.turnId === turn.turn_id).map((entry) => entry.item);
    return { ...turn, items: [...turn.items.map((item) => this.withLiveFields(item)), ...live] };
  }

  private dropLive(match: (entry: LiveItem) => boolean, announce = true): void {
    for (const [itemId, entry] of this.live) {
      if (!match(entry)) continue;
      this.live.delete(itemId);
      if (announce) this.emit({ type: 'item.removed', turn_id: entry.turnId, item_id: itemId });
    }
  }

  private async withLoadedMedia(turn: ConversationTurn): Promise<ConversationTurn> {
    const refs = new Map<string, Media['kind']>();
    for (const media of turn.items.flatMap(mediaOf)) {
      if (media.kind !== 'file' && media.url?.startsWith(BLOBREF_PREFIX) === true) refs.set(media.url, media.kind);
    }
    if (refs.size === 0) return turn;
    const loaded = new Map<string, string>();
    await Promise.all([...refs].map(async ([ref, kind]) => {
      const url = await this.loadBlob(ref, kind);
      if (url !== undefined) loaded.set(ref, url);
    }));
    return loaded.size === 0 ? turn : { ...turn, items: turn.items.map((item) => withLoadedUrls(item, loaded)) };
  }

  private async loadBlob(url: string, kind: Media['kind']): Promise<string | undefined> {
    try {
      const [loaded] = await this.handle.accessor.get(IAgentBlobService).loadParts([mediaPartOf({ kind, url })]);
      return loaded === undefined || !isMediaPart(loaded) ? undefined : mediaUrlOf(loaded);
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

function opensWithUserInput(turn: ConversationTurn): boolean {
  const opener = turn.items.find((item) => item.type === 'user_message' && item.placement === 'opener');
  return turn.kind === 'agent' && opener?.type === 'user_message' && UNDOABLE_ORIGINS.has(opener.origin.kind);
}

function headerOf(turn: ConversationTurn): ConversationTurnHeader {
  const { items: _items, ...header } = turn;
  return header;
}

function errorNotice(error: {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly retryable?: boolean;
  readonly details?: unknown;
  readonly cause?: unknown;
}): Notice {
  const { name, retryable, details, cause } = error;
  const rest = Object.fromEntries(Object.entries({ name, retryable, details, cause }).filter(([, value]) => value !== undefined));
  return {
    level: 'error',
    title: error.message,
    code: error.code,
    detail: Object.keys(rest).length === 0 ? undefined : JSON.stringify(rest, null, 2),
  };
}

function mediaOf(item: ConversationItem): readonly { readonly kind: Media['kind'] | 'file'; readonly url?: string }[] {
  if (item.type === 'user_message') return item.attachments;
  return item.type === 'tool_call' ? item.media ?? [] : [];
}

function withLoadedUrls(item: ConversationItem, loaded: ReadonlyMap<string, string>): ConversationItem {
  const swap = <M extends { readonly url?: string; readonly media_type?: string }>(media: M): M => {
    const url = media.url === undefined ? undefined : loaded.get(media.url);
    return url === undefined ? media : { ...media, url, media_type: mediaTypeOf(url) };
  };
  if (item.type === 'user_message') return { ...item, attachments: item.attachments.map(swap) };
  return item.type === 'tool_call' && item.media !== undefined ? { ...item, media: item.media.map(swap) } : item;
}

function turnBytes(turn: ConversationTurn): number {
  return Buffer.byteLength(JSON.stringify(turn)) + 1;
}

function nextProgress(progress: ToolCallItem['progress'], update: ToolUpdate): NonNullable<ToolCallItem['progress']> {
  switch (update.kind) {
    case 'progress':
      return { ...progress, percent: update.percent ?? progress?.percent, status: update.text ?? progress?.status };
    case 'status':
      return { ...progress, status: update.text ?? progress?.status };
    default:
      return { ...progress, custom_kind: update.customKind, custom_data: update.customData };
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
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field,
  );
}
