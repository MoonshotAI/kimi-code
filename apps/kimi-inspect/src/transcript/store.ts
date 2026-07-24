/**
 * Per-(session, agent) transcript state for the chat view.
 *
 * A thin observable wrapper over the package's L1 convergence path
 * (`applyOperation` on an `AgentState`) — the reducer is NOT re-implemented
 * here. State arrives through exactly two channels:
 *
 *  - REST pages (`applyPage`): the only source of FULL state. A `replace`
 *    page (initial load / full refresh) is the newest slice and replaces
 *    local state wholesale, globals included; a non-replace page is an older
 *    slice fetched with `before_turn` and prepended ahead of the loaded
 *    window (items only — globals stay with the fresher live state).
 *  - WS delta ops (`applyOps`): incremental `transcript.ops` only. Ops are
 *    idempotent upserts plus offset-placed appends, so ops buffered while a
 *    REST refresh is in flight converge when flushed onto the fresh pages.
 *
 * `onGap` surfaces `append` placement gaps so the caller can trigger a full
 * REST refresh (the WS channel carries no snapshots to fall back on).
 */

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

/**
 * Re-cover a previously loaded window after a full refresh: page backwards
 * until `prevOldestTurnId` (the window's oldest turn before the refresh) is
 * loaded again. A count-based stop silently drops the window's head when new
 * turns arrived meanwhile (the server window shifted, so the same count no
 * longer reaches as far back). Stops at the oldest available page
 * (`hasMoreOlder` false), on a no-progress page, or when `isDisposed`.
 */
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

/**
 * Serialize refresh-style triggers: at most one run in flight; a trigger that
 * arrives while a run is in flight is coalesced into exactly one follow-up run
 * (so a subscribe ack landing mid-load still produces a post-load reconcile
 * instead of being dropped).
 */
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

  /** Called when an `append` op could not be placed — the caller should refresh. */
  onGap: (() => void) | undefined;

  getState(): AgentState {
    return this.state;
  }

  /** `useSyncExternalStore`-compatible subscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Merge one REST page. With `replace`, the page is the newest slice and
   * becomes the whole state (initial load / full refresh); otherwise it is an
   * older slice prepended ahead of the window (deduped by item id), updating
   * only `items` and `hasMoreOlder`.
   */
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
        // The page contract carries no prompt slice yet; prompt.upsert ops
        // still accumulate through the shared reducer between refreshes.
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

  /** Apply incremental WS ops; notifies once per changed batch. */
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
