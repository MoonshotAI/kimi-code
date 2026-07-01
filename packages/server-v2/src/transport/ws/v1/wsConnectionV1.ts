/**
 * `/api/v1/ws` connection — speaks the v1 WebSocket protocol
 * (`server_hello` / `client_hello` / `subscribe` / `unsubscribe` / `ack` /
 * `resync_required` / `ping` / `pong` / event envelopes).
 *
 * Each connection is a {@link BroadcastTarget}: sequenced envelopes from the
 * {@link SessionEventBroadcaster} are forwarded to the socket. On
 * `client_hello` / `subscribe` it replays durable events since the client's
 * `{seq, epoch}` cursor, or sends `resync_required` when the gap cannot be
 * served incrementally.
 *
 * Mirrors v1's `WsConnection` (`packages/server/src/ws/connection.ts`).
 */

import { WS_PROTOCOL_VERSION, type SessionCursor } from '@moonshot-ai/protocol';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import type { CredentialValidator } from '../../../services/auth/credentials';
import type { IConnectionRegistry } from '../connectionRegistry';
import {
  type EventEnvelope,
  type JournalLogger,
} from './sessionEventJournal';
import {
  buildAck,
  buildPing,
  buildResyncRequired,
  buildServerHello,
} from './protocol';
import {
  type BroadcastTarget,
  type ResyncReason,
  type SessionEventBroadcaster,
} from './sessionEventBroadcaster';

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER_SIZE = 1000;

interface InboundFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

export interface WsConnectionV1Options {
  readonly socket: WebSocket;
  readonly broadcaster: SessionEventBroadcaster;
  readonly connectionRegistry: IConnectionRegistry;
  /**
   * Present-only credential check for the post-connect `client_hello`
   * handshake. The WebSocket upgrade handler (`start.ts`) is the real auth
   * gate; this is defense-in-depth so a presented handshake token must still
   * be valid. A missing token is accepted (the production web client sends
   * the bearer at the upgrade and no token in `client_hello`).
   */
  readonly validateCredential?: CredentialValidator;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly logger?: JournalLogger;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly maxBufferSize?: number;
}

export class WsConnectionV1 implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionEventBroadcaster;
  private readonly validateCredential?: CredentialValidator;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxBufferSize: number;
  private readonly logger?: JournalLogger;

  private closed = false;
  private gotClientHello = false;
  /** Session ids this connection is currently subscribed to. */
  readonly subscriptions = new Set<string>();

  private pingTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: WsConnectionV1Options) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.validateCredential = opts.validateCredential;
    this.logger = opts.logger;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry.add(this);
    this.startHeartbeat();
    this.sendFrame(
      buildServerHello({
        ws_connection_id: this.id,
        protocol_version: WS_PROTOCOL_VERSION,
        heartbeat_ms: this.pingIntervalMs,
        max_event_buffer_size: this.maxBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );
  }

  get hasClientHello(): boolean {
    return this.gotClientHello;
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions).sort();
  }

  /** BroadcastTarget — forward a sequenced envelope to the socket. */
  send(envelope: EventEnvelope): void {
    this.sendFrame(envelope);
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    let frame: InboundFrame;
    try {
      frame = JSON.parse(rawDataToString(data)) as InboundFrame;
    } catch {
      return; // non-JSON frame — drop
    }
    if (typeof frame?.type !== 'string') return;

    switch (frame.type) {
      case 'client_hello':
        void this.onClientHello(frame);
        return;
      case 'subscribe':
        void this.onSubscribe(frame);
        return;
      case 'unsubscribe':
        void this.onUnsubscribe(frame);
        return;
      case 'pong':
        this.onPong();
        return;
      default:
        // Unknown / not-yet-implemented control frame (e.g. terminal_*, abort,
        // watch_fs_*) — ignore for now; terminal/abort stay on REST.
        return;
    }
  }

  private async onClientHello(frame: InboundFrame): Promise<void> {
    if (!(await this.authorize(frame))) return;
    this.gotClientHello = true;

    const payload = frame.payload ?? {};
    const subscriptions = asStringArray(payload['subscriptions']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;

    const accepted: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of subscriptions) {
      await this.attachSession(sid, cursors?.[sid], accepted, resyncRequired, serverCursors);
    }

    this.sendFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted_subscriptions: accepted,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onSubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of sessionIds) {
      const ok = await this.broadcaster.subscribe(sid, this);
      if (!ok) {
        notFound.push(sid);
        continue;
      }
      this.subscriptions.add(sid);
      accepted.push(sid);
      const cursor = cursors?.[sid];
      if (cursor !== undefined) {
        await this.replay(sid, cursor, resyncRequired, serverCursors);
      } else {
        const cur = await this.broadcaster.getCursor(sid);
        serverCursors[sid] = cur;
      }
    }

    this.sendFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted,
        not_found: notFound,
        resync_required: resyncRequired,
        cursors: serverCursors,
      }),
    );
  }

  private async onUnsubscribe(frame: InboundFrame): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionIds = asStringArray(payload['session_ids']);
    for (const sid of sessionIds) {
      this.broadcaster.unsubscribe(sid, this);
      this.subscriptions.delete(sid);
    }
    this.sendFrame(
      buildAck(frame.id ?? '', 0, 'success', {
        accepted: [],
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private async attachSession(
    sid: string,
    cursor: SessionCursor | undefined,
    accepted: string[],
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const ok = await this.broadcaster.subscribe(sid, this);
    if (!ok) {
      resyncRequired.push(sid);
      return;
    }
    this.subscriptions.add(sid);
    accepted.push(sid);
    if (cursor !== undefined) {
      await this.replay(sid, cursor, resyncRequired, serverCursors);
    } else {
      const cur = await this.broadcaster.getCursor(sid);
      serverCursors[sid] = cur;
    }
  }

  private async replay(
    sid: string,
    cursor: SessionCursor,
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const result = await this.broadcaster.getBufferedSince(sid, cursor);
    if (result.resyncRequired !== false) {
      this.sendFrame(
        buildResyncRequired(sid, result.resyncRequired as ResyncReason, result.currentSeq, result.epoch),
      );
      resyncRequired.push(sid);
    } else {
      for (const { envelope } of result.events) this.sendFrame(envelope);
    }
    serverCursors[sid] = { seq: result.currentSeq, epoch: result.epoch };
  }

  private async authorize(frame: InboundFrame): Promise<boolean> {
    // Present-only: the upgrade handler already authenticated the socket, so a
    // missing `client_hello` token is accepted (the production web client
    // authenticates at the upgrade and sends no token here). If a token IS
    // presented it must still be valid.
    const payload = frame.payload ?? {};
    const token = typeof payload['token'] === 'string' ? (payload['token'] as string) : undefined;
    if (token === undefined || this.validateCredential === undefined) return true;
    let ok = false;
    try {
      ok = await this.validateCredential(token);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.sendFrame(buildAck(frame.id ?? '', 40112, 'unauthorized', {}));
      this.close();
      return false;
    }
    return true;
  }

  private onPong(): void {
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.sendFrame(buildPing());
      if (this.pongTimer !== undefined) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.closed) return;
        try {
          this.socket.terminate();
        } catch {
          // ignore
        }
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private sendFrame(msg: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // best-effort
    }
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    if (this.pongTimer !== undefined) clearTimeout(this.pongTimer);
    for (const sid of this.subscriptions) this.broadcaster.unsubscribe(sid, this);
    // registry removal is handled by registerWsV1 on the socket 'close' event.
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}
