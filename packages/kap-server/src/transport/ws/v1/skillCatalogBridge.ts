/**
 * `SkillCatalogBridge` — volatile `/api/v1/ws` delivery for skill-catalog changes.
 *
 * Turns the core `ISessionSkillCatalog.onDidChange` feed (payload: the changed
 * source id) into `skill_catalog.changed` frames on the v1 WebSocket:
 *
 *   server → `{type:'skill_catalog.changed', seq, session_id, timestamp, volatile:true, payload}`
 *
 * Sibling of {@link FsWatchBridge}: the frame is a pure go-refetch hint
 * (clients re-pull `GET /sessions/{sid}/skills`), so it is sent straight to the
 * socket and never enters the broadcaster / journal — no durable `seq`, no
 * replay after reconnect. Each connection numbers only the frames actually
 * delivered to it (per-connection monotonic `seq`, starting at 1); unlike the
 * fs channel, gaps carry no meaning because every hint triggers a full
 * re-pull, and `volatile: true` keeps older clients from mistaking the
 * connection-local `seq` for the durable watermark.
 *
 * Delivery set = connections subscribed to the session (the broadcaster's
 * subscribe/unsubscribe lifecycle, driven by {@link WsConnectionV1}), NOT the
 * fs-watch path sets: the bridge keeps one core subscription per session with
 * at least one attached connection and releases it when the last detaches.
 */

import {
  type IDisposable,
  ISessionSkillCatalog,
  ISessionLifecycleService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SkillCatalogChangedEvent } from './events';

import type { EventEnvelope, JournalLogger } from './sessionEventJournal';

export interface SkillCatalogChangedFrame {
  readonly type: 'skill_catalog.changed';
  readonly seq: number;
  readonly session_id: string;
  readonly timestamp: string;
  readonly volatile: true;
  readonly payload: SkillCatalogChangedEvent;
}

/** Minimal connection surface the bridge needs (satisfied by `WsConnectionV1`). */
export interface SkillCatalogConnection {
  readonly id: string;
  send(envelope: EventEnvelope): void;
}

interface ConnEntry {
  readonly conn: SkillCatalogConnection;
  /** Per-connection monotonic frame counter; starts at 0, pre-incremented per delivery. */
  seq: number;
}

interface SessionWatch {
  readonly id: string;
  readonly skillCatalog: ISessionSkillCatalog;
  readonly conns: Map<string, ConnEntry>;
  sub: IDisposable | undefined;
}

export class SkillCatalogBridge implements IDisposable {
  private readonly core: Scope;
  private readonly logger: JournalLogger | undefined;
  private readonly sessionReleaseHook: IDisposable;
  private readonly bySession = new Map<string, SessionWatch>();

  constructor(opts: { core: Scope; logger?: JournalLogger }) {
    this.core = opts.core;
    this.logger = opts.logger;
    this.sessionReleaseHook = this.core.accessor
      .get(ISessionLifecycleService)
      .hooks.onWillReleaseSession.register(
        'skillCatalogBridge',
        async ({ sessionId }, next) => {
          this.releaseSession(sessionId);
          await next();
        },
      );
  }

  dispose(): void {
    this.sessionReleaseHook.dispose();
    for (const sw of Array.from(this.bySession.values())) this.teardownSession(sw);
  }

  /** Start delivering the session's catalog hints to `conn` (session subscribe). */
  attachSession(conn: SkillCatalogConnection, sessionId: string): void {
    let sw = this.bySession.get(sessionId);
    if (sw === undefined) {
      const session = this.core.accessor.get(ISessionLifecycleService).get(sessionId);
      if (session === undefined) return;
      sw = {
        id: sessionId,
        skillCatalog: session.accessor.get(ISessionSkillCatalog),
        conns: new Map(),
        sub: undefined,
      };
      this.bySession.set(sessionId, sw);
    }
    if (!sw.conns.has(conn.id)) {
      sw.conns.set(conn.id, { conn, seq: 0 });
    }
    sw.sub ??= sw.skillCatalog.onDidChange((sourceId) => {
      this.onSessionEvent(sessionId, sourceId);
    });
  }

  /** Stop delivering to `conn` (session unsubscribe); releases the core
   *  subscription when the session has no connections left. */
  detachSession(conn: SkillCatalogConnection, sessionId: string): void {
    const sw = this.bySession.get(sessionId);
    if (sw === undefined) return;
    sw.conns.delete(conn.id);
    if (sw.conns.size === 0) this.teardownSession(sw);
  }

  /** Drop every subscription held by `conn` (called on socket close). */
  detachConnection(conn: SkillCatalogConnection): void {
    for (const sw of Array.from(this.bySession.values())) {
      if (!sw.conns.delete(conn.id)) continue;
      if (sw.conns.size === 0) this.teardownSession(sw);
    }
  }

  private teardownSession(sw: SessionWatch): void {
    sw.sub?.dispose();
    sw.sub = undefined;
    this.bySession.delete(sw.id);
  }

  private releaseSession(sessionId: string): void {
    const sw = this.bySession.get(sessionId);
    if (sw !== undefined) this.teardownSession(sw);
  }

  private onSessionEvent(sessionId: string, sourceId: string): void {
    const sw = this.bySession.get(sessionId);
    if (sw === undefined) return;
    for (const entry of sw.conns.values()) {
      entry.seq += 1;
      const frame: SkillCatalogChangedFrame = {
        type: 'skill_catalog.changed',
        seq: entry.seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        volatile: true,
        payload: { type: 'skill_catalog.changed', sourceId },
      };
      try {
        entry.conn.send(frame as EventEnvelope);
      } catch (error) {
        this.logger?.warn({ sessionId, err: String(error) }, 'skill-catalog send failed');
      }
    }
  }
}
