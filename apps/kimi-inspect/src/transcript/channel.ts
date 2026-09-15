/**
 * Chat channel — owns the `ChatStore`, the `AuditTrail`, the REST history
 * pipeline and the `/api/v3/ws` subscription for one (session, agent) pair.
 *
 * Recovery per the protocol, all of it converging through idempotent
 * replace-by-id upserts (no buffering, no cursors beyond the two REST
 * page cursors, no reset frames):
 *
 *  - Initial load / full refresh: newest REST history page (`replace`),
 *    then re-cover the previously loaded window with `before_turn` pages.
 *  - Live + recovery payload: every WS message is applied to the store
 *    as it lands; recovery and live are the same path.
 *  - Subscribe ack (initial and every reconnect): `after_step` catch-up
 *    anchored at the newest TERMINAL step (the server answers with the
 *    slice after that step's last entity, so the step that was streaming
 *    at disconnect is re-read in full; overlap is idempotent). An empty
 *    catch-up is verified against the newest page — if the anchor itself
 *    is gone (undo/clear while disconnected), fall back to a full refresh.
 *  - `in_flight` on a history response means the WS replay re-sends that
 *    step's entities from the start; nothing to do but let them land.
 */

import type { WsLikeCtor } from '../channel/wsLike';
import { AuditTrail } from '../audit/trail';
import { fetchHistoryPage, HISTORY_PAGE_SIZE, type HistoryPage } from './api';
import {
  ChatStore,
  newestTerminalStepId,
  oldestTurnId,
  recoverLoadedWindow,
} from './store';
import { ChatWs } from './ws';

export interface ChatChannelOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly pageSize?: number;
  readonly WebSocketImpl?: WsLikeCtor;
  readonly fetchImpl?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly notifyIntervalMs?: number;
  /** Fired before a replace-mode refresh drops the current window (scroll anchor hook). */
  readonly onWillReplace?: () => void;
  readonly onLoaded?: () => void;
  readonly onLoadError?: (error: unknown) => void;
}

export class ChatChannel {
  readonly store: ChatStore;
  readonly trail: AuditTrail;

  private readonly opts: ChatChannelOptions;
  private readonly pageSize: number;
  private readonly ws: ChatWs;
  private queue: Promise<void> = Promise.resolve();
  private refreshQueued = false;
  private catchUpQueued = false;
  private disposed = false;

  constructor(opts: ChatChannelOptions) {
    this.opts = opts;
    this.pageSize = opts.pageSize ?? HISTORY_PAGE_SIZE;
    this.store = new ChatStore({ notifyIntervalMs: opts.notifyIntervalMs });
    this.trail = new AuditTrail();
    this.ws = new ChatWs({
      url: opts.baseUrl,
      token: opts.token,
      sessionId: opts.sessionId,
      agentIds: [opts.agentId],
      WebSocketImpl: opts.WebSocketImpl,
      reconnectDelayMs: opts.reconnectDelayMs,
      handlers: {
        onMessage: (message) => {
          this.store.applyLive(message);
          this.trail.recordWs(message, this.store.getState());
        },
        onAck: (code, msg) => {
          if (code === 0) {
            this.trail.recordEvent('ack', undefined, this.store.getState());
            this.scheduleCatchUp();
            return;
          }
          this.trail.recordEvent('ack-error', msg, this.store.getState());
          this.opts.onLoadError?.(new Error(`subscribe rejected (${code}): ${msg ?? ''}`));
        },
        onProtocolError: (code, msg) => {
          this.trail.recordEvent('protocol-error', `${code}: ${msg}`, this.store.getState());
        },
        onInvalidFrame: () => {
          this.trail.recordEvent('invalid-frame', undefined, this.store.getState());
        },
        onReconnectScheduled: () => {
          this.trail.recordEvent('reconnect', undefined, this.store.getState());
        },
      },
    });
  }

  /** Kick the initial load (the socket is already connecting). */
  start(): void {
    this.scheduleRefresh();
  }

  /** Page one older slice into the window (`before_turn`); rejects on fetch failure. */
  async loadOlder(): Promise<void> {
    const oldest = oldestTurnId(this.store.getState().entries);
    if (oldest === undefined) return;
    const page = await this.fetchPage({ beforeTurn: oldest });
    if (this.disposed) return;
    this.store.applyHistoryPage(page.messages, 'prepend');
    this.store.setHasMoreOlder(page.messages.length === this.pageSize);
    this.trail.recordRest(
      { beforeTurn: oldest, pageSize: this.pageSize },
      'prepend',
      page.messages.length,
      page.inFlight,
      this.store.getState(),
    );
  }

  /** Force a WS reconnect (debug/testing): the ack re-triggers the after_step catch-up. */
  reconnect(delayMs = 0): void {
    this.ws.reconnect(delayMs);
  }

  close(): void {
    this.disposed = true;
    this.ws.close();
    this.store.flushNotify();
  }

  private scheduleRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    this.enqueue(async () => {
      this.refreshQueued = false;
      await this.doRefresh();
    });
  }

  private scheduleCatchUp(): void {
    if (this.catchUpQueued) return;
    this.catchUpQueued = true;
    this.enqueue(async () => {
      this.catchUpQueued = false;
      await this.doCatchUp();
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {});
  }

  private async doRefresh(): Promise<void> {
    const prevOldest = oldestTurnId(this.store.getState().entries);
    if (prevOldest !== undefined) this.opts.onWillReplace?.();
    try {
      const page = await this.fetchPage({});
      if (this.disposed) return;
      this.store.applyHistoryPage(page.messages, 'replace');
      this.store.setHasMoreOlder(page.messages.length === this.pageSize);
      this.trail.recordRest(
        { pageSize: this.pageSize },
        'replace',
        page.messages.length,
        page.inFlight,
        this.store.getState(),
      );
      await recoverLoadedWindow(
        this.store,
        prevOldest,
        async (beforeTurn) => {
          const older = await this.fetchPage({ beforeTurn });
          if (this.disposed) return [];
          this.store.setHasMoreOlder(older.messages.length === this.pageSize);
          return older.messages;
        },
        () => this.disposed,
        (beforeTurn, messages) => {
          this.trail.recordRest(
            { beforeTurn, pageSize: this.pageSize },
            'prepend',
            messages.length,
            undefined,
            this.store.getState(),
          );
        },
      );
      if (!this.disposed) this.opts.onLoaded?.();
    } catch (error) {
      if (!this.disposed) this.opts.onLoadError?.(error);
    }
  }

  private async doCatchUp(): Promise<void> {
    const anchor = newestTerminalStepId(this.store.getState().entries);
    if (anchor === undefined) {
      this.scheduleRefresh();
      return;
    }
    let cursor = anchor;
    for (;;) {
      let page: HistoryPage;
      try {
        page = await this.fetchPage({ afterStep: cursor });
      } catch (error) {
        if (!this.disposed) this.opts.onLoadError?.(error);
        return;
      }
      if (this.disposed) return;
      if (page.messages.length === 0) {
        let probe: HistoryPage;
        try {
          probe = await this.fetchPage({});
        } catch {
          return;
        }
        if (this.disposed) return;
        if (!anchorAliveInPage(probe.messages, cursor)) {
          this.trail.recordEvent(
            'catchup-refresh',
            `anchor ${cursor} no longer exists`,
            this.store.getState(),
          );
          this.scheduleRefresh();
        }
        return;
      }
      this.store.applyHistoryPage(page.messages, 'tail');
      this.trail.recordRest(
        { afterStep: cursor, pageSize: this.pageSize },
        'tail',
        page.messages.length,
        page.inFlight,
        this.store.getState(),
      );
      if (page.messages.length < this.pageSize) return;
      const next = newestTerminalStepId(this.store.getState().entries);
      if (next === undefined || next === cursor) return;
      cursor = next;
    }
  }

  private fetchPage(cursor: {
    beforeTurn?: string;
    afterStep?: string;
    pageSize?: number;
  }): Promise<HistoryPage> {
    return fetchHistoryPage({
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      sessionId: this.opts.sessionId,
      agentId: this.opts.agentId,
      beforeTurn: cursor.beforeTurn,
      afterStep: cursor.afterStep,
      pageSize: cursor.pageSize ?? this.pageSize,
      fetchImpl: this.opts.fetchImpl,
    });
  }
}

function anchorAliveInPage(messages: HistoryPage['messages'], cursor: string): boolean {
  const cursorTurn = cursor.split('.')[0]!;
  return messages.some(
    (message) =>
      ('step_id' in message && message.step_id === cursor) ||
      ('turn_id' in message && message.turn_id === cursorTurn),
  );
}
