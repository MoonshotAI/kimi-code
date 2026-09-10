/**
 * Session activity hub — owns the global-events socket and the per-session
 * coarse activity map behind the Sidebar's status badges.
 *
 * Two data sources converge into one store: the initial / reconnect
 * baseline drains the `GET /api/v1/sessions` pages (every wire session
 * carries `busy` / `main_turn_active` / `pending_interaction` /
 * `last_turn_reason`), and live updates arrive as
 * `event.session.work_changed` frames over the global WS channel (no
 * subscription needed server-side). List-level facts (session created /
 * retitled) are forwarded to the consumer as `onListChanged` so the
 * react-query session list invalidates instead of waiting out its slow poll.
 * The store is a plain subscribe/version store so React binds through
 * `useSyncExternalStore`.
 */

import type { WsLikeCtor } from '../channel/wsLike';
import { GlobalEventsWs, type SessionWorkFacts } from './ws';

export type { SessionWorkFacts };

/** `GET /api/v1/sessions` page size used while draining the seed baseline (server max). */
const SEED_PAGE_SIZE = 100;

export class SessionActivityStore {
  private activities = new Map<string, SessionWorkFacts>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get(sessionId: string): SessionWorkFacts | undefined {
    return this.activities.get(sessionId);
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyWorkChanged(sessionId: string, facts: SessionWorkFacts): void {
    const previous = this.activities.get(sessionId);
    if (
      previous !== undefined &&
      previous.busy === facts.busy &&
      previous.mainTurnActive === facts.mainTurnActive &&
      previous.pendingInteraction === facts.pendingInteraction &&
      previous.lastTurnReason === facts.lastTurnReason
    ) {
      return;
    }
    this.activities.set(sessionId, facts);
    this.bump();
  }

  /** Replace the whole map with a REST baseline (initial load / re-seed). */
  seed(entries: Iterable<readonly [string, SessionWorkFacts]>): void {
    this.activities = new Map(entries);
    this.bump();
  }

  /** Drop one session's live facts (e.g. it was archived — no further
   *  work_changed frames will arrive to correct a stale badge). */
  remove(sessionId: string): void {
    if (this.activities.delete(sessionId)) this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export interface SessionActivityHubOptions {
  /** Server base URL (`http(s)://host:port`). */
  readonly url: string;
  readonly token?: string | undefined;
  /** List-level signal (session created / retitled) — invalidate the list. */
  readonly onListChanged: () => void;
  readonly WebSocketImpl?: WsLikeCtor;
  readonly fetchImpl?: typeof fetch;
}

export class SessionActivityHub {
  readonly store = new SessionActivityStore();
  private readonly ws: GlobalEventsWs;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SessionActivityHubOptions) {
    this.baseUrl = opts.url.replace(/\/$/, '');
    this.token = opts.token;
    // Bind the default: `this.fetchImpl(...)` is a member call, and the
    // browser's `fetch` throws Illegal invocation when its receiver is not
    // the global object (Node's undici fetch does not care).
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.ws = new GlobalEventsWs({
      url: opts.url,
      token: opts.token,
      WebSocketImpl: opts.WebSocketImpl,
      handlers: {
        onWorkChanged: (sessionId, facts) => this.store.applyWorkChanged(sessionId, facts),
        onSessionCreated: () => opts.onListChanged(),
        onMetaUpdated: () => opts.onListChanged(),
        onSessionArchived: (sessionId) => {
          this.store.remove(sessionId);
          opts.onListChanged();
        },
        onSessionDeleted: (sessionId) => {
          this.store.remove(sessionId);
          opts.onListChanged();
        },
        onWorkspaceChanged: () => opts.onListChanged(),
        onReconnected: () => void this.seed(),
      },
    });
  }

  close(): void {
    this.ws.close();
  }

  private async seed(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.token !== undefined && this.token.length > 0) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    try {
      // The list is always paged (default 50, max 100): drain it with the
      // before_id cursor so every live session gets a baseline badge.
      const items: Record<string, unknown>[] = [];
      let before: string | undefined;
      for (;;) {
        const params = new URLSearchParams({ page_size: String(SEED_PAGE_SIZE) });
        if (before !== undefined) params.set('before_id', before);
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1/sessions?${params.toString()}`, {
          headers,
        });
        const envelope = (await res.json()) as {
          code: number;
          data?: { items?: Record<string, unknown>[]; has_more?: boolean };
        };
        if (envelope.code !== 0 || envelope.data?.items === undefined) return;
        items.push(...envelope.data.items);
        const lastId = envelope.data.items.at(-1)?.['id'];
        if (envelope.data.has_more !== true || typeof lastId !== 'string') break;
        before = lastId;
      }
      const entries: [string, SessionWorkFacts][] = [];
      for (const item of items) {
        const id = item['id'];
        if (typeof id !== 'string' || typeof item['busy'] !== 'boolean') continue;
        const pending = item['pending_interaction'];
        const reason = item['last_turn_reason'];
        entries.push([
          id,
          {
            busy: item['busy'],
            mainTurnActive: item['main_turn_active'] === true,
            pendingInteraction: pending === 'approval' || pending === 'question' ? pending : 'none',
            lastTurnReason:
              reason === 'completed' || reason === 'cancelled' || reason === 'failed'
                ? reason
                : undefined,
          },
        ]);
      }
      this.store.seed(entries);
    } catch {
      // Seed is best-effort: live frames keep flowing, and the next reconnect
      // re-seeds. A dead server surfaces through the connection layer anyway.
    }
  }
}
