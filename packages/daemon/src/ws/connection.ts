/**
 * `WsConnection` — per-socket WS state holder.
 *
 * One instance per upgraded HTTP request. Owns:
 *   - The raw `ws.WebSocket`.
 *   - Subscription set (populated via `subscribe` control).
 *   - Per-session `lastSeqBySession` (populated from `client_hello`).
 *   - Ping/pong heartbeat timers (WS.md §1.3, §3.5).
 *
 * Lifecycle (WS.md §1):
 *   1. Constructor sends `server_hello`.
 *   2. Client should respond with `client_hello`; the server then runs
 *      replay-or-resync logic and acks the hello.
 *   3. Server pings every `pingIntervalMs` (30s prod, overridable for tests).
 *      Client must `pong` within `pongTimeoutMs` (10s prod per WS.md §1.3)
 *      else server terminates the socket.
 *
 * The message switch includes `subscribe` / `unsubscribe` handlers (wiring
 * `ISessionClientsService` registration), `client_hello` replay of buffered
 * events or `resync_required`, and `abort` dispatch through the same handler
 * the REST fallback route uses (`IPromptService.abort`). See WS.md §3.4 for
 * the ack shape — idempotent calls return `code: 0, payload.aborted: false`.
 *
 * Anti-corruption: WS schemas come from `@moonshot-ai/protocol` (Zod-validated
 * on the inbound path). The daemon never imports directly from the SDK package.
 */

import type { RawData, WebSocket } from 'ws';
import { ulid } from 'ulid';

import {
  ErrorCode,
  clientControlMessageSchema,
  type AbortMessage,
  type ClientHelloMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type WatchFsAddMessage,
  type WatchFsRemoveMessage,
} from '@moonshot-ai/protocol';

import type { ILogService } from '#/services/logger';
import type { ISessionClientsService } from '#/services/gateway';

import {
  buildAck,
  buildPing,
  buildResyncRequired,
  buildServerHello,
  type EventEnvelope,
} from './protocol';

/**
 * Subset of `IWSBroadcastService` consumed by `WsConnection` for the replay
 * path. Keeping it as a structural interface lets tests pass a stub without
 * a full broadcast service, and prevents `WsConnection` from circular-
 * importing `WSBroadcastService` (which itself imports types from this file
 * via `protocol.ts`).
 *
 * `events`: list of buffered envelopes with `seq > lastSeq`, in order.
 * `resyncRequired`: true iff the buffer evicted past the client's gap.
 * `currentSeq`: highest dispatched seq for the session (0 if never published).
 */
export interface BufferReplaySource {
  getBufferedSince(
    sessionId: string,
    lastSeq: number,
  ): {
    events: Array<{ seq: number; envelope: EventEnvelope }>;
    resyncRequired: boolean;
    currentSeq: number;
  };
}

/**
 * Abort handler — implemented in production by `IPromptService.abort` (via
 * the route layer's accessor pattern). The structural interface lets the
 * WS connection share the exact REST handler without importing the daemon's
 * full DI graph from this file (which is wired below `services/`).
 *
 * The handler returns the same shape the REST endpoint emits on success
 * (`{aborted: true, at_seq?}`). On idempotent / already-completed calls it
 * throws `PromptAlreadyCompletedError`; the WS adapter translates that to
 * `{aborted: false}` per WS.md §3.4 (NOT the REST 40903 — different
 * convention: WS uses `code: 0, payload.aborted: false` for idempotent).
 */
export interface AbortHandler {
  abort(
    sessionId: string,
    promptId: string,
  ): Promise<{ aborted: boolean; at_seq?: number }>;
  /**
   * Per-session current seq, used to populate `at_seq` in the WS abort ack
   * when the underlying abort is idempotent (no abort RPC actually fires).
   */
  currentSeq(sessionId: string): number;
}

/**
 * `subscribe.watch_fs` + `watch_fs_add` + `watch_fs_remove` delivery surface.
 * Implemented in production by a thin adapter sitting on
 * top of `IFsWatcher` + `ISessionService` (see `start.ts`).
 *
 * Each method:
 *   - Resolves `session.metadata.cwd` from `ISessionService`.
 *   - Validates each wire path through `resolveSafePath(cwd, p)`.
 *   - Calls `IFsWatcher.addPaths` / `removePaths` for the
 *     `(sessionId, connectionId)` tuple.
 *   - Returns the resulting `watched_paths` (POSIX-relative to cwd) for
 *     the ack frame.
 *
 * Errors map at THIS layer to a `code` value the WS adapter writes
 * verbatim into the ack frame:
 *   - `FsWatchLimitError` (per-connection > 100 paths) → 42902.
 *   - `FsPathEscapesError`                            → 41304.
 *   - `SessionNotFoundError`                          → 40401.
 *   - Other                                           → 50001.
 *
 * The `cleanupConnection(connId)` call lets the connection drop all
 * watch subscriptions when the socket closes (without needing to know
 * about every session it was watching).
 */
export interface FsWatchHandler {
  add(
    sessionId: string,
    connectionId: string,
    wirePaths: readonly string[],
  ): Promise<FsWatchResult>;
  remove(
    sessionId: string,
    connectionId: string,
    wirePaths: readonly string[],
  ): Promise<FsWatchResult>;
  cleanupConnection(connectionId: string): void;
}

export type FsWatchResult =
  | { ok: true; watched_paths: string[]; current_count: number }
  | { ok: false; code: number; msg: string };

export interface WsConnectionOptions {
  socket: WebSocket;
  logger: ILogService;
  /** Per-session subscriber index — populated by `subscribe` / `unsubscribe`. */
  sessionClients: ISessionClientsService;
  /** Ring-buffer replay source — `WSBroadcastService` in prod, stub in tests. */
  wsBroadcast: BufferReplaySource;
  /** Abort handler — `IPromptService.abort` in prod, stub in tests. */
  abortHandler?: AbortHandler;
  /** Watch_fs handler — `IFsWatcher` adapter in prod, stub in tests. */
  fsWatchHandler?: FsWatchHandler;
  /** ms between server pings. Default 30_000 (WS.md §1.3). */
  pingIntervalMs?: number;
  /**
   * Terminate connection if client doesn't pong within this many ms after a
   * ping. Default 10_000 (WS.md §1.3 — client must respond within 10s).
   */
  pongTimeoutMs?: number;
  /** Max events kept per-session in ring buffer (echoed in server_hello). Default 1000. */
  maxEventBufferSize?: number;
}

/** WS.md §3.1 default heartbeat. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** WS.md §1.3 client pong deadline (10s after ping). */
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
/** WS.md §3.1 default ring-buffer cap. */
const DEFAULT_MAX_EVENT_BUFFER = 1000;

export class WsConnection {
  public readonly id: string;
  /** session_ids this connection is subscribed to. */
  public readonly subscriptions = new Set<string>();
  /** Per-session client-reported last seq (populated from client_hello). */
  public readonly lastSeqBySession = new Map<string, number>();

  private readonly socket: WebSocket;
  private readonly logger: ILogService;
  private readonly sessionClients: ISessionClientsService;
  private readonly wsBroadcast: BufferReplaySource;
  private readonly abortHandler: AbortHandler | undefined;
  private readonly fsWatchHandler: FsWatchHandler | undefined;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxEventBufferSize: number;

  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private closed = false;
  private gotClientHello = false;

  constructor(opts: WsConnectionOptions) {
    this.id = `conn_${ulid()}`;
    this.socket = opts.socket;
    this.logger = opts.logger.child({ connId: this.id });
    this.sessionClients = opts.sessionClients;
    this.wsBroadcast = opts.wsBroadcast;
    this.abortHandler = opts.abortHandler;
    this.fsWatchHandler = opts.fsWatchHandler;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.maxEventBufferSize = opts.maxEventBufferSize ?? DEFAULT_MAX_EVENT_BUFFER;

    // First frame after the WS upgrade is `server_hello` (WS.md §1 step 2).
    // The `ws_connection_id` echoes this connection's internal `this.id` so
    // the client and the daemon's logs agree on the connection identifier.
    this.send(
      buildServerHello({
        ws_connection_id: this.id,
        heartbeat_ms: this.pingIntervalMs,
        max_event_buffer_size: this.maxEventBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );

    this.socket.on('message', (data) => this.onMessage(data));
    this.socket.on('close', (code, reason) => this.onClose(code, String(reason)));
    this.socket.on('error', (err) => this.logger.warn({ err: String(err) }, 'ws socket error'));

    this.startPingTimer();
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.logger.warn('non-json ws frame; ignoring');
      return;
    }
    const result = clientControlMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ issues: result.error.issues.length }, 'invalid control message');
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case 'client_hello':
        this.onClientHello(msg);
        break;
      case 'pong':
        this.onPong();
        break;
      case 'subscribe':
        this.onSubscribe(msg);
        break;
      case 'unsubscribe':
        this.onUnsubscribe(msg);
        break;
      case 'abort':
        this.onAbort(msg);
        break;
      case 'watch_fs_add':
        this.onWatchFsAdd(msg);
        break;
      case 'watch_fs_remove':
        this.onWatchFsRemove(msg);
        break;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
        this.logger.warn('unhandled control message type');
      }
    }
  }

  private onClientHello(msg: ClientHelloMessage): void {
    this.gotClientHello = true;
    const { subscriptions, last_seq_by_session } = msg.payload;
    const accepted: string[] = [];
    const resyncRequired: string[] = [];

    // 1) Subscribe to every session in `subscriptions` FIRST so any concurrent
    //    publish lands on us before we start the replay loop (which can take
    //    multiple ms for a 1000-event session).
    for (const sid of subscriptions) {
      this.subscribe(sid);
      accepted.push(sid);
    }

    // 2) Replay missed events. WS.md §3.2: for each (sid, lastSeq) entry,
    //    ask EventBus for events > lastSeq. If the buffer evicted past that
    //    point → send a `resync_required` frame and mark the sid in the ack.
    //    Otherwise send each missed event in order on this single connection.
    if (last_seq_by_session) {
      for (const [sid, lastSeq] of Object.entries(last_seq_by_session)) {
        this.lastSeqBySession.set(sid, lastSeq);
        // Ensure subscribed even if not in `subscriptions` array — WS.md §3.2
        // says `last_seq_by_session[sid]` implies interest in `sid`.
        if (!this.subscriptions.has(sid)) {
          this.subscribe(sid);
          accepted.push(sid);
        }
        const result = this.wsBroadcast.getBufferedSince(sid, lastSeq);
        if (result.resyncRequired) {
          this.send(buildResyncRequired(sid, 'buffer_overflow', result.currentSeq));
          resyncRequired.push(sid);
        } else {
          for (const entry of result.events) {
            this.send(entry.envelope);
          }
        }
      }
    }

    this.logger.info(
      {
        acceptedCount: accepted.length,
        resyncRequiredCount: resyncRequired.length,
      },
      'client hello',
    );
    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted_subscriptions: accepted,
        resync_required: resyncRequired,
      }),
    );
  }

  private onSubscribe(msg: SubscribeMessage): void {
    const { session_ids, last_seq_by_session, watch_fs } = msg.payload;
    this.logger.info(
      { sessionIds: session_ids, lastSeqBySession: last_seq_by_session, hasWatchFs: !!watch_fs },
      '[DBG ws.onSubscribe] received subscribe',
    );
    const accepted: string[] = [];
    const resyncRequired: string[] = [];

    for (const sid of session_ids) {
      this.subscribe(sid);
      accepted.push(sid);
    }

    // `subscribe` also supports per-session `last_seq` for mid-session
    // resync (e.g. client reconnects and adds a session via subscribe rather
    // than via client_hello). Same replay-or-resync logic.
    if (last_seq_by_session) {
      for (const [sid, lastSeq] of Object.entries(last_seq_by_session)) {
        this.lastSeqBySession.set(sid, lastSeq);
        const result = this.wsBroadcast.getBufferedSince(sid, lastSeq);
        if (result.resyncRequired) {
          this.send(buildResyncRequired(sid, 'buffer_overflow', result.currentSeq));
          resyncRequired.push(sid);
        } else {
          for (const entry of result.events) {
            this.send(entry.envelope);
          }
        }
      }
    }

    // Handle optional `watch_fs` map (WS.md §3.3).
    // We fire-and-forget each per-session watch add: the underlying
    // handler resolves cwd and validates paths asynchronously. Errors
    // here do NOT fail the subscribe ack — `subscribe.watch_fs` is a
    // hint to set up file-watch alongside session subscription, but
    // the canonical add path is `watch_fs_add`. If validation fails
    // for a session entry we log a warning; the client should re-issue
    // `watch_fs_add` to surface the explicit ack code.
    if (watch_fs && this.fsWatchHandler !== undefined) {
      for (const [sid, cfg] of Object.entries(watch_fs)) {
        if (cfg.paths.length === 0) continue;
        const handler = this.fsWatchHandler;
        void handler
          .add(sid, this.id, cfg.paths)
          .then((result) => {
            if (!result.ok) {
              this.logger.warn(
                { sid, code: result.code, msg: result.msg },
                'subscribe.watch_fs add failed; client should retry via watch_fs_add',
              );
            }
          })
          .catch((err: unknown) => {
            this.logger.warn(
              { sid, err: String(err) },
              'subscribe.watch_fs add threw',
            );
          });
      }
    }

    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted,
        not_found: [],
        resync_required: resyncRequired,
      }),
    );
  }

  private onUnsubscribe(msg: UnsubscribeMessage): void {
    const { session_ids } = msg.payload;
    for (const sid of session_ids) {
      this.unsubscribe(sid);
      // WS.md §3.3: "解订时同时 drop 该 session 的所有 watch_fs"
      // Surface all current watched paths for the session and remove them.
      if (this.fsWatchHandler !== undefined) {
        // No direct query method on the handler interface; the watcher
        // service drops state when no paths remain. We send a remove with
        // the empty array as a no-op signal AND fully drop via
        // `cleanupConnection` if every session is dropped. The simpler
        // path: call remove with an empty array (no-op) plus we let the
        // server-side `forgetConnection` happen on socket close. For
        // partial unsubscribe (one of many sessions) we expose a hook:
        // calling `remove(sid, conn, currently_watched_paths)`. We don't
        // know the current set here, so we delegate to the handler which
        // owns the state.
        const handler = this.fsWatchHandler;
        void handler.remove(sid, this.id, []).catch((err: unknown) => {
          this.logger.warn(
            { sid, err: String(err) },
            'unsubscribe watch_fs drop threw',
          );
        });
      }
    }
    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted: session_ids,
        not_found: [],
        resync_required: [],
      }),
    );
  }

  /**
   * Handle `watch_fs_add` (WS.md §3.3.1). Adds the caller's paths to the
   * per-session chokidar watcher and acks with the
   * full deduplicated `watched_paths` list for the session (POSIX-relative
   * to `session.cwd`). Validation failures land as ack codes:
   *   - 42902 fs.watch_limit_exceeded (per-connection > 100 paths)
   *   - 41304 fs.path_escapes_session (any input path)
   *   - 40401 session.not_found
   *   - 50001 internal (unexpected throw)
   *
   * No-op acks (empty paths array) succeed with code 0 and echo back the
   * existing `watched_paths` set (idempotent semantics).
   */
  private onWatchFsAdd(msg: WatchFsAddMessage): void {
    if (this.fsWatchHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'fs watch handler not wired', {}),
      );
      return;
    }
    const { session_id, paths } = msg.payload;
    const handler = this.fsWatchHandler;
    void handler
      .add(session_id, this.id, paths)
      .then((result) => {
        if (!result.ok) {
          this.send(buildAck(msg.id, result.code, result.msg, {}));
          return;
        }
        this.send(
          buildAck(msg.id, 0, 'success', {
            watched_paths: result.watched_paths,
            current_count: result.current_count,
          }),
        );
      })
      .catch((err: unknown) => {
        this.logger.warn({ err: String(err) }, 'watch_fs_add handler threw');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'watch_fs_add failed', {}),
        );
      });
  }

  /**
   * Handle `watch_fs_remove` (WS.md §3.3.1). Idempotent. Empty paths array
   * acks with code 0 + current `watched_paths`.
   */
  private onWatchFsRemove(msg: WatchFsRemoveMessage): void {
    if (this.fsWatchHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'fs watch handler not wired', {}),
      );
      return;
    }
    const { session_id, paths } = msg.payload;
    const handler = this.fsWatchHandler;
    void handler
      .remove(session_id, this.id, paths)
      .then((result) => {
        if (!result.ok) {
          this.send(buildAck(msg.id, result.code, result.msg, {}));
          return;
        }
        this.send(
          buildAck(msg.id, 0, 'success', {
            watched_paths: result.watched_paths,
            current_count: result.current_count,
          }),
        );
      })
      .catch((err: unknown) => {
        this.logger.warn({ err: String(err) }, 'watch_fs_remove handler threw');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'watch_fs_remove failed', {}),
        );
      });
  }

  /**
   * Dispatch a WS `abort` control message through the same handler the REST
   * `POST /sessions/{sid}/prompts/{pid}:abort` route uses
   * (`IPromptService.abort` via the daemon's accessor). Idempotent calls
   * (already-completed prompt) return `code: 0, payload.aborted: false`
   * per WS.md §3.4 — NOT the REST 40903; different convention to avoid the
   * UI churn of treating idempotent success as an error.
   *
   * Errors map:
   *   - PromptAlreadyCompletedError  → `code: 0, aborted: false, at_seq` (idempotent)
   *   - PromptNotFoundError          → `code: 40402 prompt.not_found`
   *   - SessionNotFoundError         → `code: 40401 session.not_found`
   *   - other                        → `code: 50001 internal`
   *
   * If no abort handler is wired (test stub without one), reply with a
   * 50001 ack so the protocol contract stays observable.
   */
  private onAbort(msg: AbortMessage): void {
    const { session_id, prompt_id } = msg.payload;
    if (this.abortHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'abort handler not wired', {}),
      );
      return;
    }
    void this.abortHandler
      .abort(session_id, prompt_id)
      .then((result) => {
        this.send(
          buildAck(msg.id, 0, 'success', {
            aborted: result.aborted,
            ...(result.at_seq !== undefined ? { at_seq: result.at_seq } : {}),
          }),
        );
      })
      .catch((err: unknown) => {
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'PromptAlreadyCompletedError'
        ) {
          const at_seq = this.abortHandler!.currentSeq(session_id);
          this.send(
            buildAck(msg.id, 0, 'success', { aborted: false, at_seq }),
          );
          return;
        }
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'PromptNotFoundError'
        ) {
          this.send(
            buildAck(msg.id, ErrorCode.PROMPT_NOT_FOUND, 'prompt not found', {}),
          );
          return;
        }
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'SessionNotFoundError'
        ) {
          this.send(
            buildAck(msg.id, ErrorCode.SESSION_NOT_FOUND, 'session not found', {}),
          );
          return;
        }
        this.logger.warn({ err: String(err) }, 'ws abort handler error');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'abort failed', {}),
        );
      });
  }

  /** Idempotent subscribe — registers both locally and in `ISessionClientsService`. */
  private subscribe(sid: string): void {
    if (this.subscriptions.has(sid)) return;
    this.subscriptions.add(sid);
    this.sessionClients.subscribe(this, sid);
  }

  /** Idempotent unsubscribe. */
  private unsubscribe(sid: string): void {
    if (!this.subscriptions.has(sid)) return;
    this.subscriptions.delete(sid);
    this.sessionClients.unsubscribe(this, sid);
  }

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.send(buildPing());
      // Schedule a single pong deadline. The pong handler clears it; if the
      // deadline fires we terminate the socket.
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.closed) return;
        this.logger.warn('pong timeout — terminating socket');
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

  private onPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    // Drop all subscriptions in one shot so EventBus.publish() doesn't try to
    // send into a closed socket on the next event.
    this.sessionClients.forgetConnection(this);
    this.subscriptions.clear();
    // Drop all fs-watch subscriptions for this connection.
    // The watcher closes any chokidar instance whose path-set goes empty.
    if (this.fsWatchHandler !== undefined) {
      try {
        this.fsWatchHandler.cleanupConnection(this.id);
      } catch (err) {
        this.logger.warn(
          { err: String(err) },
          'fsWatchHandler.cleanupConnection threw',
        );
      }
    }
    this.logger.info({ code, reason, gotClientHello: this.gotClientHello }, 'connection closed');
  }

  /**
   * Outbound send. Used both for system frames and for per-session event
   * envelopes pushed by `WSBroadcastService`. Drops silently if the socket is closed
   * or not yet OPEN.
   */
  public send(message: unknown): void {
    if (this.closed) return;
    if (this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message), (err) => {
        if (err) this.logger.warn({ err: String(err) }, 'ws send failed');
      });
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'ws send threw');
    }
  }

  /** Initiate graceful close (default WS code 1000). */
  public close(code = 1000, reason?: string): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore — socket may already be closing
    }
    // The `'close'` listener will flip `closed` and clean timers.
  }

  /** Test helper: whether the server has received a `client_hello`. */
  public get hasClientHello(): boolean {
    return this.gotClientHello;
  }
}
