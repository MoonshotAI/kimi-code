/**
 * `/api/v1/ws` connection — speaks the v1 WebSocket protocol
 * (`server_hello` / `client_hello` / `subscribe` / `unsubscribe` / `ack` /
 * `resync_required` / event envelopes).
 *
 * Each connection is a {@link BroadcastTarget}: sequenced envelopes from the
 * {@link SessionEventBroadcaster} are forwarded to the socket. On
 * `client_hello` / `subscribe` it replays durable events since the client's
 * `{seq, epoch}` cursor, or sends `resync_required` when the gap cannot be
 * served incrementally.
 *
 * The server never initiates a disconnect: unlike v1's `WsConnection`
 * (`packages/server/src/ws/connection.ts`) there is no ping/pong heartbeat —
 * a connection stays open until the client closes it or the process shuts
 * down.
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
  buildResyncRequired,
  buildServerHello,
} from './protocol';
import {
  type AgentFilter,
  type BroadcastTarget,
  type ResyncReason,
  type SessionEventBroadcaster,
} from './sessionEventBroadcaster';
import { FsWatchBridge } from './fsWatchBridge';

const DEFAULT_MAX_BUFFER_SIZE = 1000;

// Outbound send buffer — coalesces a burst of frames (notably high-frequency
// volatile text deltas) into fewer `socket.send` calls and applies backpressure
// when the peer is not draining fast enough. See `flush()` / `coalesceFrames`.
const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20; // 1 MiB
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 100;

interface InboundFrame {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
}

export interface WsConnectionV1Options {
  readonly socket: WebSocket;
  readonly broadcaster: SessionEventBroadcaster;
  readonly fsWatchBridge?: FsWatchBridge;
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
  readonly maxBufferSize?: number;
  /** Delay before a buffered batch is flushed; coalesces frames within the window. */
  readonly flushIntervalMs?: number;
  /** Flush immediately once this many frames are queued, even before the interval. */
  readonly maxBatchSize?: number;
  /** `socket.bufferedAmount` above which flushing is deferred (backpressure). */
  readonly highWaterMarkBytes?: number;
}

export class WsConnectionV1 implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionEventBroadcaster;
  private readonly fsWatchBridge?: FsWatchBridge;
  private readonly validateCredential?: CredentialValidator;
  private readonly maxBufferSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly logger?: JournalLogger;

  private closed = false;
  private gotClientHello = false;
  /** Per-session subscription state, with each session's optional agent allowlist. */
  readonly subscriptions = new Map<string, AgentFilter>();

  /** Outbound frames awaiting the next flush. */
  private outbound: unknown[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private backpressureRetryTimer?: ReturnType<typeof setTimeout>;
  /** Epoch ms when the current backpressure deferral started; caps the wait. */
  private backpressureSince?: number;

  constructor(opts: WsConnectionV1Options) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.fsWatchBridge = opts.fsWatchBridge;
    this.validateCredential = opts.validateCredential;
    this.logger = opts.logger;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry.add(this);
    this.sendFrame(
      buildServerHello({
        ws_connection_id: this.id,
        protocol_version: WS_PROTOCOL_VERSION,
        max_event_buffer_size: this.maxBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );
  }

  get hasClientHello(): boolean {
    return this.gotClientHello;
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions.keys()).sort();
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
      case 'watch_fs_add':
        void this.onWatchFs(frame, true);
        return;
      case 'watch_fs_remove':
        void this.onWatchFs(frame, false);
        return;
      default:
        // Unknown / not-yet-implemented control frame (e.g. terminal_*, abort)
        // — ignore for now; terminal/abort stay on REST.
        return;
    }
  }

  private async onClientHello(frame: InboundFrame): Promise<void> {
    if (!(await this.authorize(frame))) return;
    this.gotClientHello = true;

    const payload = frame.payload ?? {};
    const subscriptions = asStringArray(payload['subscriptions']);
    const cursors = payload['cursors'] as Record<string, SessionCursor> | undefined;
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of subscriptions) {
      await this.attachSession(
        sid,
        cursors?.[sid],
        agentFilter?.[sid],
        accepted,
        resyncRequired,
        serverCursors,
      );
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
    const agentFilter = parseAgentFilter(payload['agent_filter']);

    const accepted: string[] = [];
    const notFound: string[] = [];
    const resyncRequired: string[] = [];
    const serverCursors: Record<string, { seq: number; epoch?: string }> = {};

    for (const sid of sessionIds) {
      const filter = agentFilter?.[sid];
      const ok = await this.broadcaster.subscribe(sid, this, filter);
      if (!ok) {
        notFound.push(sid);
        continue;
      }
      this.subscriptions.set(sid, filter);
      accepted.push(sid);
      const cursor = cursors?.[sid];
      if (cursor !== undefined) {
        await this.replay(sid, cursor, filter, resyncRequired, serverCursors);
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

  private async onWatchFs(frame: InboundFrame, isAdd: boolean): Promise<void> {
    const payload = frame.payload ?? {};
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : '';
    const paths = asStringArray(payload['paths']);
    const bridge = this.fsWatchBridge;
    if (bridge === undefined) {
      this.sendFrame(buildAck(frame.id ?? '', 1, 'fs watch unavailable', {}));
      return;
    }
    let result;
    try {
      result = isAdd
        ? await bridge.addWatch(this, sessionId, paths)
        : await bridge.removeWatch(this, sessionId, paths);
    } catch (error) {
      this.sendFrame(
        buildAck(frame.id ?? '', 1, 'internal error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    this.sendFrame(
      buildAck(frame.id ?? '', result.code, result.msg, {
        watched_paths: result.watched_paths ?? [],
        current_count: result.current_count ?? 0,
      }),
    );
  }

  private async attachSession(
    sid: string,
    cursor: SessionCursor | undefined,
    filter: AgentFilter | undefined,
    accepted: string[],
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const ok = await this.broadcaster.subscribe(sid, this, filter);
    if (!ok) {
      resyncRequired.push(sid);
      return;
    }
    this.subscriptions.set(sid, filter);
    accepted.push(sid);
    if (cursor !== undefined) {
      await this.replay(sid, cursor, filter, resyncRequired, serverCursors);
    } else {
      const cur = await this.broadcaster.getCursor(sid);
      serverCursors[sid] = cur;
    }
  }

  private async replay(
    sid: string,
    cursor: SessionCursor,
    filter: AgentFilter | undefined,
    resyncRequired: string[],
    serverCursors: Record<string, { seq: number; epoch?: string }>,
  ): Promise<void> {
    const result = await this.broadcaster.getBufferedSince(sid, cursor, filter);
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

  private sendFrame(msg: unknown): void {
    if (this.closed) return;
    this.outbound.push(msg);
    if (this.outbound.length >= this.maxBatchSize) {
      // Batch is full — flush now rather than wait for the interval.
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /**
   * Drain the outbound buffer: coalesce adjacent compatible volatile deltas,
   * then write the surviving frames to the socket. When the peer is not
   * draining (`bufferedAmount` above the high-water mark) and `force` is not
   * set, defer and keep accumulating — later deltas merge into the queued
   * ones, so the frame count does not grow while we wait.
   */
  private flush(force = false): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.outbound.length === 0) return;
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      // Socket is gone — drop queued frames rather than send into a dead pipe.
      this.outbound = [];
      return;
    }

    if (!force && this.socket.bufferedAmount > this.highWaterMarkBytes) {
      this.deferForBackpressure();
      return;
    }
    this.backpressureSince = undefined;

    const frames = coalesceFrames(this.outbound);
    this.outbound = [];
    for (const frame of frames) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      try {
        this.socket.send(JSON.stringify(frame));
      } catch {
        // best-effort
      }
    }
  }

  private deferForBackpressure(): void {
    const now = Date.now();
    if (this.backpressureSince === undefined) this.backpressureSince = now;
    if (now - this.backpressureSince >= DEFAULT_BACKPRESSURE_MAX_DELAY_MS) {
      // Peer stayed above the watermark too long — force-flush to avoid
      // starving the stream; the socket layer will buffer or drop.
      this.flush(true);
      return;
    }
    if (this.backpressureRetryTimer !== undefined) return;
    this.backpressureRetryTimer = setTimeout(() => {
      this.backpressureRetryTimer = undefined;
      this.flush();
    }, DEFAULT_BACKPRESSURE_RETRY_MS);
    this.backpressureRetryTimer.unref?.();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    // Best-effort: push out any queued frames (e.g. the tail of a delta
    // stream) before tearing the socket down, so the client sees a complete
    // stream rather than a truncated one.
    this.flush(true);
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.backpressureRetryTimer !== undefined) clearTimeout(this.backpressureRetryTimer);
    this.outbound = [];
    for (const sid of this.subscriptions.keys()) this.broadcaster.unsubscribe(sid, this);
    this.fsWatchBridge?.detachConnection(this);
    // registry removal is handled by registerWsV1 on the socket 'close' event.
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Parse the wire `agent_filter` payload (`Record<session_id, agent_id[]>`) into
 * a per-session allowlist map. Sessions missing from the returned map — or the
 * whole field absent — fall back to "every agent" (`undefined`), the legacy
 * session-grained behavior. Malformed entries (non-object, empty arrays,
 * non-string ids) are dropped per-session rather than failing the whole
 * handshake, so a bad entry cannot widen another session's filter.
 */
function parseAgentFilter(value: unknown): Record<string, AgentFilter> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AgentFilter> = {};
  for (const [sid, ids] of Object.entries(value)) {
    if (!Array.isArray(ids)) continue;
    const set = new Set(ids.filter((v): v is string => typeof v === 'string'));
    if (set.size === 0) continue;
    out[sid] = set;
  }
  return out;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

// ---------------------------------------------------------------------------
// Outbound coalescing
// ---------------------------------------------------------------------------

/** A volatile text-delta envelope that can be merged with an adjacent one. */
interface CoalescableDelta {
  type: 'assistant.delta' | 'thinking.delta';
  seq: number;
  volatile: true;
  offset?: number;
  session_id?: string;
  timestamp: string;
  payload: {
    agentId?: string;
    turnId?: number;
    delta: string;
    [key: string]: unknown;
  };
}

function isCoalescableDelta(frame: unknown): frame is CoalescableDelta {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f['volatile'] !== true) return false;
  const type = f['type'];
  if (type !== 'assistant.delta' && type !== 'thinking.delta') return false;
  const payload = f['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  return typeof (payload as Record<string, unknown>)['delta'] === 'string';
}

/**
 * Merge adjacent compatible volatile text deltas into a single envelope.
 *
 * Two adjacent frames merge when both are `volatile` `assistant.delta` /
 * `thinking.delta` of the same type, addressed to the same session, agent,
 * and turn. The merged frame keeps the first frame's `seq` / `offset` /
 * `timestamp` and concatenates `payload.delta` in order — the client's
 * offset-based alignment against the in-flight snapshot stays correct
 * (the broadcaster's per-session dispatch queue guarantees consecutive deltas
 * for a turn carry consecutive offsets).
 *
 * Durable events, control frames, and non-text deltas are never merged, and
 * merging never crosses a non-mergeable frame, so overall ordering is
 * preserved. The input frames are not mutated; merged results are fresh
 * objects. Exported for unit testing.
 */
export function coalesceFrames(frames: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const frame of frames) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      isCoalescableDelta(last) &&
      isCoalescableDelta(frame) &&
      last.type === frame.type &&
      last.session_id === frame.session_id &&
      last.payload.agentId === frame.payload.agentId &&
      last.payload.turnId === frame.payload.turnId
    ) {
      out[out.length - 1] = {
        ...last,
        payload: { ...last.payload, delta: last.payload.delta + frame.payload.delta },
      };
    } else {
      out.push(frame);
    }
  }
  return out;
}
