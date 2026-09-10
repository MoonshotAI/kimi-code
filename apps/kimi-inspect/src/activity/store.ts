/**
 * Session activity hub — owns the global-events socket and the per-session
 * coarse activity map behind the Sidebar's status badges.
 *
 * Two data sources converge into one store: the initial / reconnect
 * baseline comes from a single `GET /api/v1/sessions` page (every wire
 * session carries `busy` / `main_turn_active` / `pending_interaction` /
 * `last_turn_reason`), and live updates arrive as `session` global messages
 * over the `/api/v3/ws` channel (no subscription needed server-side — the
 * embedded SessionInfo carries the same four facts). List-level facts
 * (session created / retitled / archived / deleted, workspace changed) are
 * forwarded to the consumer as `onListChanged` so the react-query session
 * list invalidates instead of waiting out its slow poll. The store is a
 * plain subscribe/version store so React binds through
 * `useSyncExternalStore`.
 */

import type { SessionInfo, SessionMessage } from '@moonshot-ai/kap-server/protocol';

import type { WsLikeCtor } from '../channel/wsLike';
import { GlobalEventsWs } from './ws';

export type SessionPendingInteraction = 'none' | 'approval' | 'question';
export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface SessionWorkFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: SessionTurnOutcome | undefined;
}

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

  /** Drop one session's live facts (e.g. it was archived or deleted — no
   *  further messages will arrive to correct a stale badge). */
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
        onSession: (message) => this.onSession(message, opts.onListChanged),
        onWorkspaceChanged: () => opts.onListChanged(),
        onReconnected: () => void this.seed(),
      },
    });
  }

  close(): void {
    this.ws.close();
  }

  private onSession(message: SessionMessage, onListChanged: () => void): void {
    const { subtype, session } = message;
    if (subtype === 'archived' || subtype === 'deleted') {
      this.store.remove(session.id);
    } else {
      this.store.applyWorkChanged(session.id, workFactsOf(session));
    }
    onListChanged();
  }

  private async seed(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.token !== undefined && this.token.length > 0) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/sessions`, { headers });
      const envelope = (await res.json()) as {
        code: number;
        data?: { items?: Record<string, unknown>[] };
      };
      if (envelope.code !== 0 || envelope.data?.items === undefined) return;
      const entries: [string, SessionWorkFacts][] = [];
      for (const item of envelope.data.items) {
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
      // Seed is best-effort: live messages keep flowing, and the next
      // reconnect re-seeds. A dead server surfaces through the connection
      // layer anyway.
    }
  }
}

function workFactsOf(session: SessionInfo): SessionWorkFacts {
  return {
    busy: session.busy,
    mainTurnActive: session.main_turn_active === true,
    pendingInteraction: session.pending_interaction ?? 'none',
    lastTurnReason: session.last_turn_reason,
  };
}
