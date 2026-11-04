import {
  ContextUndone,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  IAgentBlobService,
  IAgentFullCompactionService,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  PromptCompleted,
  SubagentSpawned,
  type IAgentScopeHandle,
  type IDisposable,
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
  TurnStepStreamReset,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { AgentErrorEvent } from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';
import { WarningIssued } from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  ConversationItem,
  ConversationTurn,
  ConversationTurnHeader,
  ConversationTurnsPage,
} from '../../protocol/conversation';
import type { MessageContent } from '../../protocol/message';
import {
  applyConversationRecord,
  createConversationState,
  undoConversationTurns,
  type ConversationState,
} from './conversationFold';

export type ConversationEvent =
  | { readonly type: 'turn.started' | 'turn.updated' | 'turn.ended'; readonly turn: ConversationTurnHeader }
  | { readonly type: 'item.started' | 'item.updated' | 'item.ended'; readonly turn_id: string; readonly item: ConversationItem }
  | { readonly type: 'item.delta'; readonly turn_id: string; readonly item_id: string; readonly delta: string }
  | { readonly type: 'item.removed'; readonly turn_id: string; readonly item_id: string }
  | { readonly type: 'turns.removed'; readonly turn_ids: string[] }
  | {
      readonly type: 'notice';
      readonly level: 'error' | 'warning';
      readonly message: string;
      readonly code?: string;
      readonly payload?: Record<string, unknown>;
    };

export type ConversationListener = (event: ConversationEvent) => void;

interface LiveItem {
  readonly turnId: string;
  readonly stepId: string;
  readonly startedAt: number;
  item: ConversationItem;
}

const RECORD_EVENTS = [
  TurnPrompt,
  ContextAppendMessage,
  ContextAppendLoopEvent,
  TurnSteer,
  TurnCancel,
  TurnStepInterrupted,
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

export class ConversationFeed implements IDisposable {
  private readonly initial = createConversationState();
  private state: ConversationState = this.initial;
  private sent: readonly ConversationTurn[] = [];
  private started = false;
  private restoring = false;
  private flushQueued = false;
  private disposed = false;
  private readonly live = new Map<string, LiveItem>();
  private readonly listeners = new Set<ConversationListener>();
  private readonly disposables: IDisposable[] = [];

  static async attach(handle: IAgentScopeHandle): Promise<ConversationFeed> {
    const feed = new ConversationFeed(handle);
    try {
      await feed.start();
    } catch (error) {
      feed.dispose();
      throw error;
    }
    return feed;
  }

  private constructor(private readonly handle: IAgentScopeHandle) {}

  get agentId(): string {
    return this.handle.id;
  }

  turns(): readonly ConversationTurn[] {
    return this.state.turns;
  }

  subscribe(listener: ConversationListener): IDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  snapshot(before: number | undefined, limit: number): Omit<ConversationTurnsPage, 'agent_id'> {
    const turns = this.state.turns;
    const end = before === undefined ? turns.length : turns.findIndex((turn) => turn.ordinal >= before);
    const stop = end === -1 ? turns.length : end;
    const start = Math.max(0, stop - limit);
    return { turns: turns.slice(start, stop).map((turn) => this.present(turn)), has_more: start > 0 };
  }

  async hydrate(turns: readonly ConversationTurn[]): Promise<ConversationTurn[]> {
    const blobs = this.handle.accessor.get(IAgentBlobService);
    return Promise.all(turns.map(async (turn) => {
      if (!turn.items.some(hasBlobRef)) return turn;
      const items = await Promise.all(turn.items.map((item) => hydrateItem(item, blobs)));
      return { ...turn, items };
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.listeners.clear();
    this.live.clear();
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
        this.onToolCallDelta(event.turnId, event.toolCallId, event.name);
      }),
      bus.subscribe(TurnStepStreamReset, (event) => {
        this.dropLive((entry) => entry.stepId === event.stepId);
      }),
      bus.subscribe(ContextUndone, () => {
        this.finishRestore();
      }),
      bus.subscribe(WarningIssued, (event) => {
        this.emit({ type: 'notice', level: 'warning', message: event.message, code: event.code });
      }),
      bus.subscribe(AgentErrorEvent, (event) => {
        this.emit({
          type: 'notice',
          level: 'error',
          message: event.message,
          code: event.code,
          payload: {
            code: event.code,
            message: event.message,
            name: event.name,
            retryable: event.retryable,
            details: event.details,
          },
        });
      }),
    );
    const attachment = await this.handle.accessor.get(IEventDispatcher).attachLate({
      id: 'kap.conversation',
      events: RECORD_EVENTS,
      undoable: true,
      transition: (draft, event) => {
        applyConversationRecord(draft, event.serialize());
      },
      onUndo: (draft, count) => undoConversationTurns(draft, count),
      getState: () => this.state,
      commit: (next) => {
        this.commit(next);
      },
    });
    this.disposables.push(attachment);
    this.sent = this.state.turns;
    this.started = true;
  }

  private commit(next: ConversationState): void {
    if (next === this.initial && this.started) {
      this.restoring = true;
      this.dropLive(() => true);
    }
    this.state = next;
    if (!this.started || this.restoring || this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private finishRestore(): void {
    if (!this.restoring) return;
    this.restoring = false;
    const previous = new Map(this.sent.map((turn) => [turn.turn_id, turn]));
    const current = new Set(this.state.turns.map((turn) => turn.turn_id));
    const removed = this.sent.filter((turn) => !current.has(turn.turn_id)).map((turn) => turn.turn_id);
    this.sent = this.state.turns;
    if (removed.length > 0) this.emit({ type: 'turns.removed', turn_ids: removed });
    for (const turn of this.state.turns) {
      const before = previous.get(turn.turn_id);
      if (before === undefined) continue;
      for (const event of restoredTurnEvents(before, turn)) this.emit(event);
    }
  }

  private flush(): void {
    if (this.disposed || this.restoring) return;
    const previous = this.sent;
    const next = this.state.turns;
    if (previous === next) return;
    this.sent = next;
    const previousById = new Map(previous.map((turn) => [turn.turn_id, turn]));
    const nextIds = new Set<string>();
    for (const turn of next) {
      nextIds.add(turn.turn_id);
      const before = previousById.get(turn.turn_id);
      if (before !== turn) this.emitTurnChanges(before, turn);
    }
    const removed = previous.filter((turn) => !nextIds.has(turn.turn_id)).map((turn) => turn.turn_id);
    if (removed.length > 0) {
      const gone = new Set(removed);
      this.dropLive((entry) => gone.has(entry.turnId), false);
      this.emit({ type: 'turns.removed', turn_ids: removed });
    }
  }

  private emitTurnChanges(before: ConversationTurn | undefined, turn: ConversationTurn): void {
    if (before === undefined) this.emit({ type: 'turn.started', turn: headerOf(turn) });
    const previousItems = new Map(before?.items.map((item) => [item.item_id, item]));
    for (const item of turn.items) {
      const previousItem = previousItems.get(item.item_id);
      if (previousItem === item) continue;
      const wasLive = this.live.delete(item.item_id);
      const type = item.status === 'ended'
        ? 'item.ended'
        : previousItem === undefined && !wasLive
          ? 'item.started'
          : 'item.updated';
      this.emit({ type, turn_id: turn.turn_id, item });
    }
    this.dropLive((entry) => entry.turnId === turn.turn_id && !this.liveStepOpen(turn, entry.stepId));
    if (before !== undefined && headerUnchanged(before, turn)) return;
    if (turn.status === 'ended' && before?.status !== 'ended') {
      this.emit({ type: 'turn.ended', turn: headerOf(turn) });
    } else if (before !== undefined) {
      this.emit({ type: 'turn.updated', turn: headerOf(turn) });
    }
  }

  private onTextDelta(
    type: 'assistant_message' | 'reasoning',
    turnNumber: number,
    block: number | undefined,
    delta: string,
  ): void {
    if (block === undefined || delta.length === 0) return;
    const target = this.liveTarget(turnNumber);
    if (target === undefined) return;
    const itemId = `${target.stepId}:${block}`;
    const entry = this.live.get(itemId);
    if (entry !== undefined) {
      if (entry.item.type !== type) return;
      entry.item = { ...entry.item, text: entry.item.text + delta };
      this.emit({ type: 'item.delta', turn_id: target.turn.turn_id, item_id: itemId, delta });
      return;
    }
    if (target.turn.items.some((item) => item.item_id === itemId)) return;
    this.endLiveBlocks(target.stepId);
    const startedAt = Date.now();
    const item: ConversationItem = type === 'reasoning'
      ? { type, item_id: itemId, status: 'running', step_index: target.stepIndex, text: delta, started_at: new Date(startedAt).toISOString() }
      : { type, item_id: itemId, status: 'running', step_index: target.stepIndex, text: delta };
    this.live.set(itemId, { turnId: target.turn.turn_id, stepId: target.stepId, startedAt, item });
    this.emit({ type: 'item.started', turn_id: target.turn.turn_id, item });
  }

  private onToolCallDelta(turnNumber: number, toolCallId: string, name: string | undefined): void {
    if (name === undefined || this.live.has(toolCallId)) return;
    const target = this.liveTarget(turnNumber);
    if (target === undefined || target.turn.items.some((item) => item.item_id === toolCallId)) return;
    this.endLiveBlocks(target.stepId);
    const item: ConversationItem = { type: 'tool_call', item_id: toolCallId, status: 'running', step_index: target.stepIndex, name };
    this.live.set(toolCallId, { turnId: target.turn.turn_id, stepId: target.stepId, startedAt: Date.now(), item });
    this.emit({ type: 'item.started', turn_id: target.turn.turn_id, item });
  }

  private endLiveBlocks(stepId: string): void {
    const now = Date.now();
    for (const entry of this.live.values()) {
      if (entry.stepId !== stepId || entry.item.status !== 'running') continue;
      if (entry.item.type === 'reasoning') {
        entry.item = { ...entry.item, status: 'ended', duration_ms: now - entry.startedAt };
      } else if (entry.item.type === 'assistant_message') {
        entry.item = { ...entry.item, status: 'ended' };
      } else {
        continue;
      }
      this.emit({ type: 'item.ended', turn_id: entry.turnId, item: entry.item });
    }
  }

  private liveTarget(turnNumber: number): { turn: ConversationTurn; stepId: string; stepIndex: number } | undefined {
    const turn = this.state.turns.findLast((candidate) => candidate.turn_number === turnNumber && candidate.status === 'running');
    const step = turn?.steps.at(-1);
    if (turn === undefined || step === undefined || step.ended_at !== undefined) return undefined;
    return { turn, stepId: step.step_id, stepIndex: step.index };
  }

  private liveStepOpen(turn: ConversationTurn, stepId: string): boolean {
    if (turn.status !== 'running') return false;
    const step = turn.steps.findLast((candidate) => candidate.step_id === stepId);
    return step !== undefined && step.ended_at === undefined;
  }

  private dropLive(match: (entry: LiveItem) => boolean, announce = true): void {
    for (const [itemId, entry] of this.live) {
      if (!match(entry)) continue;
      this.live.delete(itemId);
      if (announce) this.emit({ type: 'item.removed', turn_id: entry.turnId, item_id: itemId });
    }
  }

  private present(turn: ConversationTurn): ConversationTurn {
    const liveItems = [...this.live.values()].filter((entry) => entry.turnId === turn.turn_id).map((entry) => entry.item);
    let presented = liveItems.length === 0 ? turn : { ...turn, items: [...turn.items, ...liveItems] };
    if (presented.status === 'running' && !this.isActive(presented)) {
      presented = { ...presented, status: 'ended', outcome: 'interrupted' };
    }
    return presented;
  }

  private isActive(turn: ConversationTurn): boolean {
    if (turn.kind === 'system') {
      return this.handle.accessor.get(IAgentFullCompactionService).compacting !== null;
    }
    const loop = this.handle.accessor.get(IAgentLoopService).snapshot();
    if (loop.state !== 'running') return false;
    return loop.activeTurnId === undefined || turn.turn_number === undefined || loop.activeTurnId === turn.turn_number;
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

function headerOf(turn: ConversationTurn): ConversationTurnHeader {
  const { items: _items, ...header } = turn;
  return header;
}

export function restoredTurnEvents(before: ConversationTurn, after: ConversationTurn): ConversationEvent[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const turnId = after.turn_id;
  const kept = new Set(after.items.map((item) => item.item_id));
  const previousItems = new Map(before.items.map((item) => [item.item_id, JSON.stringify(item)]));
  const events: ConversationEvent[] = before.items
    .filter((item) => !kept.has(item.item_id))
    .map((item) => ({ type: 'item.removed', turn_id: turnId, item_id: item.item_id }));
  for (const item of after.items) {
    if (previousItems.get(item.item_id) === JSON.stringify(item)) continue;
    events.push({ type: item.status === 'ended' ? 'item.ended' : 'item.updated', turn_id: turnId, item });
  }
  const header = headerOf(after);
  if (JSON.stringify(headerOf(before)) !== JSON.stringify(header)) events.push({ type: 'turn.updated', turn: header });
  return events;
}

function headerUnchanged(before: ConversationTurn, after: ConversationTurn): boolean {
  return (
    before.status === after.status &&
    before.outcome === after.outcome &&
    before.error === after.error &&
    before.turn_number === after.turn_number &&
    before.ended_at === after.ended_at &&
    before.duration_ms === after.duration_ms &&
    before.steps === after.steps
  );
}

function hasBlobRef(item: ConversationItem): boolean {
  if (item.type === 'user_message') return item.content.some((part) => blobRefOf(part) !== undefined);
  if (item.type === 'tool_call' && Array.isArray(item.output)) {
    return (item.output as unknown[]).some((part) => imageUrlOf(part)?.startsWith(BLOBREF_PREFIX) === true);
  }
  return false;
}

async function hydrateItem(item: ConversationItem, blobs: IAgentBlobService): Promise<ConversationItem> {
  if (item.type === 'user_message') {
    const content = await Promise.all(item.content.map(async (part): Promise<MessageContent> => {
      const ref = blobRefOf(part);
      if (ref === undefined || (part.type !== 'image' && part.type !== 'video')) return part;
      const [loaded] = await blobs.loadParts([{ type: 'image_url', imageUrl: { url: ref } }]);
      const url = loaded === undefined ? undefined : imageUrlOf(loaded);
      const match = url === undefined ? null : /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match === null) return part;
      return { ...part, source: { kind: 'base64', media_type: match[1]!, data: match[2]! } };
    }));
    return { ...item, content };
  }
  if (item.type === 'tool_call' && Array.isArray(item.output)) {
    return { ...item, output: await blobs.loadParts(item.output as ContentPart[]) };
  }
  return item;
}

function blobRefOf(part: MessageContent): string | undefined {
  if (part.type !== 'image' && part.type !== 'video') return undefined;
  const source = part.source;
  return source.kind === 'url' && source.url.startsWith(BLOBREF_PREFIX) ? source.url : undefined;
}

function imageUrlOf(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  const url = (part as { imageUrl?: { url?: unknown } }).imageUrl?.url;
  return typeof url === 'string' ? url : undefined;
}
