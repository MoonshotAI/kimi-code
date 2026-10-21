import {
  applyOperation,
  EMPTY_AGENT_STATE,
  itemId,
  type AgentState,
  type TranscriptItem,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { TranscriptPage } from './api';

export function countTurns(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) if (item.kind === 'turn') count += 1;
  return count;
}

export function oldestTurnId(items: readonly TranscriptItem[]): string | undefined {
  for (const item of items) if (item.kind === 'turn') return item.turnId;
  return undefined;
}

export function hasTurnId(items: readonly TranscriptItem[], turnId: string): boolean {
  return items.some((item) => item.kind === 'turn' && item.turnId === turnId);
}

export async function recoverLoadedWindow(
  store: TranscriptChatStore,
  prevOldestTurnId: string | undefined,
  fetchPage: (beforeTurn: string) => Promise<TranscriptPage>,
  isDisposed: () => boolean,
  onPageApplied?: (page: TranscriptPage) => void,
): Promise<void> {
  if (prevOldestTurnId === undefined) return;
  while (!hasTurnId(store.getState().items, prevOldestTurnId) && store.getState().hasMoreOlder) {
    const oldest = oldestTurnId(store.getState().items);
    if (oldest === undefined) break;
    const before = countTurns(store.getState().items);
    const page = await fetchPage(oldest);
    if (isDisposed()) return;
    store.applyPage(page);
    onPageApplied?.(page);
    if (countTurns(store.getState().items) === before) break;
  }
}

export function createCoalescedRunner(run: () => Promise<void>): () => void {
  let running = false;
  let queued = false;
  const kick = (): void => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    void run().finally(() => {
      running = false;
      if (queued) {
        queued = false;
        kick();
      }
    });
  };
  return kick;
}

export class TranscriptChatStore {
  private state: AgentState = EMPTY_AGENT_STATE;
  private readonly listeners = new Set<() => void>();

  onGap: (() => void) | undefined;

  getState(): AgentState {
    return this.state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  applyPage(page: TranscriptPage, opts?: { replace?: boolean }): void {
    if (opts?.replace === true) {
      this.state = {
        items: page.items,
        tasks: new Map(page.tasks.map((task) => [task.taskId, task])),
        interactions: new Map(
          page.interactions.map((interaction) => [interaction.interactionId, interaction]),
        ),
        attachments: new Map(
          page.attachments.map((attachment) => [attachment.attachmentId, attachment]),
        ),
        todos: new Map(page.todos.map((todo) => [todo.todoId, todo])),
        prompts: new Map(),
        meta: page.meta,
        pendingInteractions: new Set(page.pendingInteractions),
        hasMoreOlder: page.hasMoreOlder,
      };
      this.notify();
      return;
    }
    const existing = new Set(this.state.items.map(itemId));
    const fresh = page.items.filter((item) => !existing.has(itemId(item)));
    if (fresh.length === 0 && page.hasMoreOlder === this.state.hasMoreOlder) return;
    this.state = {
      ...this.state,
      items: [...fresh, ...this.state.items],
      hasMoreOlder: page.hasMoreOlder,
    };
    this.notify();
  }

  applyOps(ops: readonly TranscriptOperation[]): void {
    let changed = false;
    for (const op of ops) {
      const result = applyOperation(this.state, op);
      if (result.gap !== undefined) this.onGap?.();
      if (!result.changed) continue;
      this.state = result.state;
      changed = true;
    }
    if (changed) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
