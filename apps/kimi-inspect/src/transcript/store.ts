/**
 * Per-(session, agent) chat state for the message protocol v3.
 *
 * The store is a deliberately thin reflection of the wire: every entity
 * message upserts by (type, own id) with its content fields as the
 * authoritative whole (replace-by-id), the delta family
 * (`assistant.delta` / `thinking.delta` / `tool_call.delta`) appends to the
 * already-existing entity (an entity always precedes its deltas on the
 * stream; an orphan delta is dropped — the entity's next upsert carries the
 * cumulative content anyway), and `tool.progress` patches the entity's
 * latest-progress field. Recovery payloads and live traffic are applied
 * through the exact same path — idempotent overwrite makes them
 * indistinguishable, so there is no reset/buffer/cursor machinery at all.
 *
 * `system(undo)` / `system(clear)` land on the timeline in place AND
 * truncate it: every entry whose own id is in `payload.removed_ids` is
 * dropped together with its subtree (all entries carrying that turn_id),
 * and interactions anchored at a removed tool call are cascaded out.
 *
 * State entities have one channel each: `interaction` / `task` / `todo`
 * upsert into keyed maps, `session.state` replaces the single latest
 * snapshot. Global messages (workspace/session/config/…) are not consumed
 * by this store.
 *
 * An upsert whose `timestamp` is strictly older than the held entity's is
 * skipped: a REST page folded before a live update must not rewind it.
 *
 * Notifications are trailing-edge throttled (`notifyIntervalMs`) so a
 * per-token delta stream does not become a per-token React render; state
 * reads (`getState`) always see the latest applied message regardless.
 */

import type {
  AssistantMessage,
  HistoryMessage,
  InteractionMessage,
  ServerMessage,
  SessionStateMessage,
  SystemMessage,
  TaskMessage,
  ThinkingMessage,
  TodoMessage,
  ToolCallMessage,
} from '@moonshot-ai/kap-server/protocol';

export type TimelineMessage =
  | Extract<HistoryMessage, { type: 'turn' }>
  | Extract<HistoryMessage, { type: 'step' }>
  | Extract<HistoryMessage, { type: 'user' }>
  | AssistantMessage
  | ThinkingMessage
  | ToolCallMessage
  | SystemMessage;

export interface TimelineEntry {
  readonly key: string;
  readonly message: TimelineMessage;
}

export interface ChatState {
  readonly entries: readonly TimelineEntry[];
  readonly interactions: ReadonlyMap<string, InteractionMessage>;
  readonly tasks: ReadonlyMap<string, TaskMessage>;
  readonly todos: ReadonlyMap<string, TodoMessage>;
  readonly sessionState: SessionStateMessage | undefined;
  readonly hasMoreOlder: boolean;
}

export const EMPTY_CHAT_STATE: ChatState = {
  entries: [],
  interactions: new Map(),
  tasks: new Map(),
  todos: new Map(),
  sessionState: undefined,
  hasMoreOlder: false,
};

export type HistoryPageMode = 'replace' | 'prepend' | 'tail';

export function timelineKeyOf(message: TimelineMessage): string {
  switch (message.type) {
    case 'turn':
      return `turn:${message.turn_id}`;
    case 'step':
      return `step:${message.step_id}`;
    case 'user':
    case 'assistant':
    case 'thinking':
      return `${message.type}:${message.message_id}`;
    case 'tool_call':
      return `tool_call:${message.tool_call_id}`;
    case 'system':
      return `system:${message.system_id}`;
  }
}

function ownIdOf(message: TimelineMessage): string {
  switch (message.type) {
    case 'turn':
      return message.turn_id;
    case 'step':
      return message.step_id;
    case 'user':
    case 'assistant':
    case 'thinking':
      return message.message_id;
    case 'tool_call':
      return message.tool_call_id;
    case 'system':
      return message.system_id;
  }
}

export function turnIdOf(message: TimelineMessage): string | undefined {
  return message.type === 'system' ? undefined : message.turn_id;
}

export function oldestTurnId(entries: readonly TimelineEntry[]): string | undefined {
  for (const entry of entries) {
    const turnId = turnIdOf(entry.message);
    if (turnId !== undefined) return turnId;
  }
  return undefined;
}

export function hasTurnId(entries: readonly TimelineEntry[], turnId: string): boolean {
  return entries.some((entry) => turnIdOf(entry.message) === turnId);
}

export function newestTerminalStepId(entries: readonly TimelineEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i]!.message;
    if (message.type === 'step' && message.state !== 'running') return message.step_id;
  }
  return undefined;
}

/**
 * Re-cover a previously loaded window after a replace-mode refresh: page
 * backwards until `prevOldestTurnId` is loaded again (a count-based stop
 * silently drops the window's head when new turns arrived meanwhile). Stops
 * at the oldest available page, on a no-progress page, or when `isDisposed`.
 */
export async function recoverLoadedWindow(
  store: ChatStore,
  prevOldestTurnId: string | undefined,
  fetchPage: (beforeTurn: string) => Promise<readonly HistoryMessage[]>,
  isDisposed: () => boolean,
  onPageApplied?: (beforeTurn: string, messages: readonly HistoryMessage[]) => void,
): Promise<void> {
  if (prevOldestTurnId === undefined) return;
  while (!hasTurnId(store.getState().entries, prevOldestTurnId) && store.getState().hasMoreOlder) {
    const oldest = oldestTurnId(store.getState().entries);
    if (oldest === undefined) break;
    const before = store.getState().entries.length;
    const page = await fetchPage(oldest);
    if (isDisposed()) return;
    store.applyHistoryPage(page, 'prepend');
    onPageApplied?.(oldest, page);
    if (store.getState().entries.length === before) break;
  }
}

export class ChatStore {
  private state: ChatState = EMPTY_CHAT_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly notifyIntervalMs: number;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(opts?: { notifyIntervalMs?: number }) {
    this.notifyIntervalMs = opts?.notifyIntervalMs ?? 80;
  }

  getState(): ChatState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setHasMoreOlder(flag: boolean): void {
    if (this.state.hasMoreOlder === flag) return;
    this.state = { ...this.state, hasMoreOlder: flag };
    this.scheduleNotify();
  }

  /**
   * Merge one REST history page. `replace` installs the page as the whole
   * window (entries absent from it are dropped, except ones newer than the
   * page's newest timestamp — live traffic that outran the fetch);
   * `prepend` inserts the older slice ahead of the window (deduped by key);
   * `tail` upserts the catch-up slice in page order. system(undo/clear)
   * messages inside a page truncate exactly like live ones.
   */
  applyHistoryPage(messages: readonly HistoryMessage[], mode: HistoryPageMode): void {
    if (mode === 'replace') {
      const pageMax = maxTimestamp(messages);
      const carried = pageMax === undefined ? [] : this.newerThan(this.state.entries, pageMax);
      const next: TimelineEntry[] = [];
      const seen = new Set<string>();
      for (const message of messages) {
        if (!isTimelineMessage(message)) {
          this.applyStateMessage(message);
          continue;
        }
        const key = timelineKeyOf(message);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(this.preferHeld(key, message));
      }
      for (const entry of carried) {
        if (!seen.has(entry.key)) next.push(entry);
      }
      this.state = { ...this.state, entries: next };
      this.applyTruncations(messages);
      this.scheduleNotify();
      return;
    }
    if (mode === 'prepend') {
      const existing = new Set(this.state.entries.map((entry) => entry.key));
      const fresh: TimelineEntry[] = [];
      for (const message of messages) {
        if (!isTimelineMessage(message)) {
          this.applyStateMessage(message);
          continue;
        }
        const key = timelineKeyOf(message);
        if (existing.has(key)) continue;
        existing.add(key);
        fresh.push({ key, message });
      }
      if (fresh.length > 0) {
        this.state = { ...this.state, entries: [...fresh, ...this.state.entries] };
      }
      this.applyTruncations(messages);
      this.scheduleNotify();
      return;
    }
    for (const message of messages) this.applyEntity(message);
  }

  /** Apply one live (or recovery) WS message; recovery and live share this path. */
  applyLive(message: ServerMessage): void {
    switch (message.type) {
      case 'assistant.delta': {
        this.patchText(`assistant:${message.message_id}`, message.text);
        return;
      }
      case 'thinking.delta': {
        this.patchText(`thinking:${message.message_id}`, message.text);
        return;
      }
      case 'tool_call.delta': {
        this.patchToolCall(message.tool_call_id, (call) => ({
          ...call,
          input_text: (call.input_text ?? '') + message.input_text,
        }));
        return;
      }
      case 'tool.progress': {
        this.patchToolCall(message.tool_call_id, (call) => ({ ...call, progress: message.progress }));
        return;
      }
      case 'interaction':
      case 'task':
      case 'todo':
      case 'session.state': {
        this.applyStateMessage(message);
        return;
      }
      case 'turn':
      case 'step':
      case 'user':
      case 'assistant':
      case 'thinking':
      case 'tool_call':
      case 'system': {
        this.applyEntity(message);
        return;
      }
      default:
        return;
    }
  }

  /** Flush a pending throttled notification (teardown / explicit sync point). */
  flushNotify(): void {
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }

  private applyEntity(message: HistoryMessage): void {
    if (!isTimelineMessage(message)) {
      this.applyStateMessage(message);
      return;
    }
    const key = timelineKeyOf(message);
    const index = this.state.entries.findIndex((entry) => entry.key === key);
    if (index < 0) {
      this.state = { ...this.state, entries: [...this.state.entries, { key, message }] };
    } else {
      const held = this.state.entries[index]!.message;
      if (held === message || held.timestamp > message.timestamp) return;
      const entries = [...this.state.entries];
      entries[index] = { key, message };
      this.state = { ...this.state, entries };
    }
    if (message.type === 'system' && (message.subtype === 'undo' || message.subtype === 'clear')) {
      this.truncate(message);
    }
    this.scheduleNotify();
  }

  private applyStateMessage(
    message: InteractionMessage | TaskMessage | TodoMessage | SessionStateMessage,
  ): void {
    switch (message.type) {
      case 'interaction': {
        const held = this.state.interactions.get(message.interaction_id);
        if (held === message) return;
        if (held !== undefined && held.timestamp > message.timestamp) return;
        const interactions = new Map([
          ...this.state.interactions,
          [message.interaction_id, message] as const,
        ]);
        this.state = { ...this.state, interactions };
        break;
      }
      case 'task': {
        const held = this.state.tasks.get(message.task_id);
        if (held === message) return;
        if (held !== undefined && held.timestamp > message.timestamp) return;
        const tasks = new Map([...this.state.tasks, [message.task_id, message] as const]);
        this.state = { ...this.state, tasks };
        break;
      }
      case 'todo': {
        const held = this.state.todos.get(message.todo_id);
        if (held === message) return;
        if (held !== undefined && held.timestamp > message.timestamp) return;
        const todos = new Map([...this.state.todos, [message.todo_id, message] as const]);
        this.state = { ...this.state, todos };
        break;
      }
      case 'session.state': {
        const held = this.state.sessionState;
        if (held === message) return;
        if (held !== undefined && held.timestamp > message.timestamp) return;
        this.state = { ...this.state, sessionState: message };
        break;
      }
    }
    this.scheduleNotify();
  }

  private patchText(key: string, text: string): void {
    this.patchEntry(key, (message) => {
      if (message.type !== 'assistant' && message.type !== 'thinking') return message;
      return { ...message, text: message.text + text };
    });
  }

  private patchToolCall(
    toolCallId: string,
    patch: (call: ToolCallMessage) => ToolCallMessage,
  ): void {
    this.patchEntry(`tool_call:${toolCallId}`, (message) => {
      if (message.type !== 'tool_call') return message;
      return patch(message);
    });
  }

  private patchEntry(key: string, patch: (message: TimelineMessage) => TimelineMessage): void {
    const index = this.state.entries.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    const current = this.state.entries[index]!;
    const next = patch(current.message);
    if (next === current.message) return;
    const entries = [...this.state.entries];
    entries[index] = { key, message: next };
    this.state = { ...this.state, entries };
    this.scheduleNotify();
  }

  private applyTruncations(messages: readonly HistoryMessage[]): void {
    for (const message of messages) {
      if (message.type === 'system' && (message.subtype === 'undo' || message.subtype === 'clear')) {
        this.truncate(message);
      }
    }
  }

  private truncate(message: SystemMessage): void {
    if (message.subtype !== 'undo' && message.subtype !== 'clear') return;
    const removed = new Set(message.payload.removed_ids);
    if (removed.size === 0) return;
    const removedToolCalls = new Set<string>();
    const entries = this.state.entries.filter((entry) => {
      const current = entry.message;
      if (removed.has(ownIdOf(current))) {
        if (current.type === 'tool_call') removedToolCalls.add(current.tool_call_id);
        return false;
      }
      if (current.type !== 'system' && removed.has(current.turn_id)) {
        if (current.type === 'tool_call') removedToolCalls.add(current.tool_call_id);
        return false;
      }
      return true;
    });
    let interactions = this.state.interactions;
    if (removedToolCalls.size > 0) {
      const next = new Map(interactions);
      for (const [id, interaction] of next) {
        if (interaction.tool_call_id !== undefined && removedToolCalls.has(interaction.tool_call_id)) {
          next.delete(id);
        }
      }
      interactions = next;
    }
    this.state = { ...this.state, entries, interactions };
  }

  private preferHeld(key: string, message: TimelineMessage): TimelineEntry {
    const held = this.state.entries.find((entry) => entry.key === key);
    if (held !== undefined && held.message.timestamp > message.timestamp) return held;
    return { key, message };
  }

  private newerThan(entries: readonly TimelineEntry[], timestamp: string): TimelineEntry[] {
    return entries.filter((entry) => entry.message.timestamp > timestamp);
  }

  private scheduleNotify(): void {
    this.dirty = true;
    if (this.notifyIntervalMs <= 0) {
      this.flushNotify();
      return;
    }
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.flushNotify();
    }, this.notifyIntervalMs);
    this.notifyTimer.unref?.();
  }
}

function isTimelineMessage(
  message: HistoryMessage | ServerMessage,
): message is TimelineMessage {
  switch (message.type) {
    case 'turn':
    case 'step':
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'tool_call':
    case 'system':
      return true;
    default:
      return false;
  }
}

function maxTimestamp(messages: readonly HistoryMessage[]): string | undefined {
  let max: string | undefined;
  for (const message of messages) {
    if (max === undefined || message.timestamp > max) max = message.timestamp;
  }
  return max;
}
