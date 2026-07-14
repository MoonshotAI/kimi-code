/**
 * Promise-based modal panel queue for interaction dialogs.
 *
 * Approval and question flows wait for a UI action before writing the
 * decision back to the session broker. When concurrent pendings arrive (e.g.
 * multiple parallel subagents each needing approval), only one panel is shown
 * at a time; additional payloads are queued in arrival order and advance after
 * the current one resolves.
 *
 * A queued payload can settle two ways:
 * - `respond(data)` — the user made a choice; `show()` resolves with it.
 * - retraction (`retract` / `retractAll`) — the pending was resolved outside
 *   the panel (another client, session detach); `show()` resolves with
 *   `undefined` and the caller must NOT write a decision back.
 */

export interface PanelQueueUIHooks<TPayload> {
  showPanel(payload: TPayload): void;
  hidePanel(): void;
}

interface PendingEntry<TPayload, TResponse> {
  readonly payload: TPayload;
  readonly resolve: (data: TResponse | undefined) => void;
}

export class PanelQueue<TPayload, TResponse> {
  private uiHooks: PanelQueueUIHooks<TPayload> | null = null;
  private current: PendingEntry<TPayload, TResponse> | null = null;
  private queue: Array<PendingEntry<TPayload, TResponse>> = [];

  setUIHooks(hooks: PanelQueueUIHooks<TPayload>): void {
    this.uiHooks = hooks;
  }

  /**
   * Present a payload (immediately, or once earlier ones settle). The returned
   * promise resolves with the user's response, or `undefined` when the entry
   * was retracted before the user answered.
   */
  show(payload: TPayload): Promise<TResponse | undefined> {
    return new Promise<TResponse | undefined>((resolve) => {
      const entry: PendingEntry<TPayload, TResponse> = { payload, resolve };
      if (this.current === null) {
        this.current = entry;
        this.uiHooks?.showPanel(payload);
      } else {
        this.queue.push(entry);
      }
    });
  }

  /** Called by the UI after the user makes a panel choice. */
  respond(data: TResponse): void {
    const pending = this.current;
    this.current = null;
    pending?.resolve(data);
    if (pending !== null) {
      this.drainAutoResolved(pending.payload, data);
    }
    this.advanceOrHide();
  }

  /**
   * Drop entries whose payload matches, resolving their `show()` promise with
   * `undefined`. Used when a pending is resolved outside the panel.
   */
  retract(matches: (payload: TPayload) => boolean): void {
    this.queue = this.queue.filter((entry) => {
      if (!matches(entry.payload)) return true;
      entry.resolve(undefined);
      return false;
    });
    if (this.current !== null && matches(this.current.payload)) {
      const current = this.current;
      this.current = null;
      current.resolve(undefined);
      this.advanceOrHide();
    }
  }

  /** Retract everything (session detach / shutdown) and hide the panel. */
  retractAll(): void {
    const all = [...(this.current === null ? [] : [this.current]), ...this.queue];
    const hadCurrent = this.current !== null;
    this.current = null;
    this.queue = [];
    if (hadCurrent) this.uiHooks?.hidePanel();
    for (const entry of all) {
      entry.resolve(undefined);
    }
  }

  hasPending(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  private advanceOrHide(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.uiHooks?.hidePanel();
      return;
    }
    this.current = next;
    this.uiHooks?.showPanel(next.payload);
  }

  private drainAutoResolved(resolvedPayload: TPayload, response: TResponse): void {
    const remaining: Array<PendingEntry<TPayload, TResponse>> = [];
    for (const entry of this.queue) {
      const auto = this.autoResolveFor(resolvedPayload, response, entry.payload);
      if (auto === undefined) {
        remaining.push(entry);
      } else {
        entry.resolve(auto);
      }
    }
    this.queue = remaining;
  }

  /**
   * Subclasses override to short-circuit queued payloads when an answer to the
   * just-resolved one (e.g. an approve-for-session) implies the same answer
   * for matching queued payloads. Return `undefined` to leave the queued
   * payload waiting for its own panel turn.
   */
  protected autoResolveFor(
    _resolvedPayload: TPayload,
    _response: TResponse,
    _queuedPayload: TPayload,
  ): TResponse | undefined {
    return undefined;
  }
}
