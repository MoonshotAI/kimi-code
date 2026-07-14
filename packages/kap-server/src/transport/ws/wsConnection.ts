/**
 * `/api/v2` WebSocket connection — per-connection lifecycle.
 *
 * Multiplexes RPC `call`s and event `listen`s over one socket, carrying the
 * safety features from v1's `WsConnection` and VSCode's `ChannelServer`:
 *   - request ids + active-request table (cancel / unlisten disposes them)
 *   - schema validation (invalid frames are dropped, not fatal)
 *   - graceful cleanup on close (dispose listeners, cancel pending)
 *   - no stack traces over the wire
 *
 * The server never initiates a disconnect: there is no heartbeat / pong
 * timeout — a connection stays open until the client closes it or the process
 * shuts down.
 *
 * Captures per-connection metadata (`connectedAt`, `remoteAddress`,
 * `userAgent`, handshake state) and tracks the session ids of active
 * session/agent-scoped `listen`s so the `GET /api/v1/connections` mirror route
 * can list live clients in the v1 wire shape.
 */

import { ErrorCodes, Error2, type IDisposable, type Scope } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import type { ScopeKind } from '../channel';
import { dispatch, resolveScope, resolveService } from '../dispatcher';
import { assertSerializable, mapError } from '../errors';
import type { CredentialValidator } from '../../services/auth/credentials';
import { resolveEventSource } from './eventMap';
import type { CallMessage, ListenMessage, ServerMessage } from './wsProtocol';
import { clientMessageSchema } from './wsProtocol';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface PendingEntry {
  /** Dispose the listener / drop the call result. */
  readonly cancel: () => void;
}

export interface WsConnectionOptions {
  readonly socket: WebSocket;
  readonly core: Scope;
  /**
   * Present-only credential check for the post-connect `hello` handshake. The
   * WebSocket upgrade handler (`start.ts`) is the real auth gate; this is a
   * defense-in-depth check so a presented handshake token must still be valid.
   * When omitted, the handshake accepts any client (upgrade already ran).
   */
  readonly validateCredential?: CredentialValidator;
  readonly callTimeoutMs?: number;
  /** ISO 8601 timestamp the socket was accepted at; defaults to `now`. */
  readonly connectedAt?: string;
  /** Peer address as seen by the server socket. Null when unavailable. */
  readonly remoteAddress: string | null;
  /** `User-Agent` header from the upgrade request. Null when absent. */
  readonly userAgent: string | null;
}

export class WsConnection {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  private readonly socket: WebSocket;
  private readonly core: Scope;
  private readonly validateCredential?: CredentialValidator;
  private readonly callTimeoutMs: number;

  private closed = false;
  private gotHello = false;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly eventWaits = new Map<string, Map<string, () => void>>();
  /** Active session/agent-scoped `listen`s: listen id → session id. */
  private readonly subscriptions = new Map<string, string>();

  constructor(opts: WsConnectionOptions) {
    this.id = `conn_${ulid()}`;
    this.connectedAt = opts.connectedAt ?? new Date().toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.core = opts.core;
    this.validateCredential = opts.validateCredential;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    this.send({ type: 'ready' });
  }

  /** Whether the client has completed the `hello` (auth) handshake. */
  get hasClientHello(): boolean {
    return this.gotHello;
  }

  /**
   * Distinct session ids this connection currently has an active session- or
   * agent-scoped `listen` for — the v2 projection of v1's `subscriptions`.
   */
  get subscriptionSessionIds(): readonly string[] {
    return Array.from(new Set(this.subscriptions.values())).sort();
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onMessage(data: RawData): void {
    if (this.closed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      return; // non-JSON frame — drop
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) return; // invalid frame — drop, don't tear down

    const msg = result.data;
    switch (msg.type) {
      case 'hello':
        this.onHello(msg.token);
        return;
      case 'call':
        void this.onCall(msg);
        return;
      case 'cancel':
        this.cancel(msg.id);
        return;
      case 'listen':
        void this.onListen(msg);
        return;
      case 'unlisten':
        this.cancel(msg.id);
        return;
      case 'event_result':
        this.finishEventWait(msg.id, msg.eventId);
        return;
    }
  }

  private onHello(token: string | undefined): void {
    // The upgrade handler (`start.ts`) is the real auth gate: every connection
    // reaching here already presented a valid bearer, so the handshake is
    // accepted synchronously. (Setting `gotHello` must stay synchronous — an
    // awaited validation would yield and let a following `call` frame observe
    // `gotHello === false`.) A presented handshake token is still re-checked
    // as defense-in-depth; a mismatch closes the socket. A missing token is
    // accepted because the upgrade already authenticated the socket. This keeps
    // the credential validated at upgrade consistent with the handshake and
    // closes the old "rpcToken unset ⇒ no-auth" hole.
    this.gotHello = true;
    if (token !== undefined && this.validateCredential !== undefined) {
      void this.validateCredential(token)
        .then((ok) => {
          if (!ok && !this.closed) {
            this.send({ type: 'error', id: '', code: 40112, msg: 'unauthorized' });
            this.close();
          }
        })
        .catch(() => {
          // best-effort; the upgrade already authenticated the socket
        });
    }
  }

  private async onCall(msg: CallMessage): Promise<void> {
    if (!this.gotHello) {
      this.send({ type: 'error', id: msg.id, code: 40112, msg: 'hello required' });
      return;
    }

    // Track so `cancel` can drop the result.
    let settled = false;
    const entry: PendingEntry = {
      cancel: () => {
        settled = true;
        this.pending.delete(msg.id);
      },
    };
    this.pending.set(msg.id, entry);

    try {
      const data = await withTimeoutWs(
        dispatch(
          this.core,
          msg.scope as ScopeKind,
          scopeParams(msg),
          msg.service,
          msg.method,
          msg.arg,
        ),
        this.callTimeoutMs,
      );
      if (settled || this.closed) return;
      this.pending.delete(msg.id);
      this.send({ type: 'result', id: msg.id, data });
    } catch (error) {
      if (settled || this.closed) return;
      this.pending.delete(msg.id);
      const env = mapError(error, msg.id);
      this.send({ type: 'error', id: msg.id, code: env.code, msg: env.msg });
    }
  }

  private async onListen(msg: ListenMessage): Promise<void> {
    if (!this.gotHello) {
      this.send({ type: 'error', id: msg.id, code: 40112, msg: 'hello required' });
      return;
    }
    if (this.pending.has(msg.id)) {
      this.send({ type: 'error', id: msg.id, code: 40001, msg: `id already in use: ${msg.id}` });
      return;
    }

    let disposable: IDisposable;
    try {
      if (msg.service !== undefined) {
        const service = await resolveService(
          this.core,
          msg.scope as ScopeKind,
          scopeParams(msg),
          msg.service,
        );
        const event = (service as Record<string, unknown>)[msg.event];
        if (typeof event !== 'function' || !/^on[A-Z]/.test(msg.event)) {
          throw new Error2(
            ErrorCodes.REQUEST_INVALID,
            `event not found: ${msg.service}.${msg.event}`,
          );
        }
        disposable = (event as (listener: (data: unknown) => void) => IDisposable).call(
          service,
          (data) => this.sendEvent(msg.id, msg.event, data),
        );
      } else {
        const source = resolveEventSource(msg.scope as ScopeKind, msg.event);
        if (source === undefined) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, `unknown event: ${msg.event}`);
        }
        const scope = await resolveScope(this.core, msg.scope as ScopeKind, scopeParams(msg));
        if (scope === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${msg.sessionId ?? ''} not found`,
          );
        }
        disposable = source.subscribe(scope, (data) => this.sendEvent(msg.id, msg.event, data));
      }
    } catch (error) {
      const env = mapError(error, msg.id);
      this.send({ type: 'error', id: msg.id, code: env.code, msg: env.msg });
      return;
    }

    if ((msg.scope === 'session' || msg.scope === 'agent') && msg.sessionId !== undefined) {
      this.subscriptions.set(msg.id, msg.sessionId);
    }
    this.pending.set(msg.id, {
      cancel: () => {
        disposable.dispose();
        this.pending.delete(msg.id);
        this.subscriptions.delete(msg.id);
      },
    });
    this.send({ type: 'listen_result', id: msg.id });
  }

  private cancel(id: string): void {
    const entry = this.pending.get(id);
    if (entry !== undefined) entry.cancel();
    this.cancelEventWaits(id);
  }

  private finishEventWait(id: string, eventId: string): void {
    this.eventWaits.get(id)?.get(eventId)?.();
  }

  private cancelEventWaits(id: string): void {
    const waits = this.eventWaits.get(id);
    if (waits === undefined) return;
    for (const [eventId, finish] of waits) {
      this.send({ type: 'event_cancel', id, eventId });
      finish();
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private sendEvent(id: string, event: string, data: unknown): void {
    if (this.closed) return;
    const isWill = /^onWill[A-Z]/.test(event);
    try {
      const wire = assertSerializable(
        isWill && data !== null && typeof data === 'object'
          ? Object.fromEntries(
              Object.entries(data as Record<string, unknown>).filter(
                ([key]) => key !== 'waitUntil' && key !== 'signal',
              ),
            )
          : data,
      );
      if (!isWill) {
        this.send({ type: 'event', id, data: wire });
        return;
      }
      const eventId = ulid();
      const promise = new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          const waits = this.eventWaits.get(id);
          waits?.delete(eventId);
          if (waits?.size === 0) this.eventWaits.delete(id);
          resolve();
        };
        const waits = this.eventWaits.get(id) ?? new Map<string, () => void>();
        waits.set(eventId, finish);
        this.eventWaits.set(id, waits);
      });
      (data as { waitUntil(promise: Promise<unknown>): void }).waitUntil(promise);
      this.send({ type: 'event', id, eventId, data: wire });
    } catch (error) {
      const env = mapError(error, id);
      this.send({ type: 'error', id, code: env.code, msg: env.msg });
      this.cancel(id);
    }
  }

  private send(msg: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

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
    for (const entry of this.pending.values()) {
      try {
        entry.cancel();
      } catch {
        // ignore cleanup errors
      }
    }
    this.pending.clear();
    for (const waits of this.eventWaits.values()) {
      for (const finish of waits.values()) finish();
    }
    this.eventWaits.clear();
  }
}

function scopeParams(msg: { sessionId?: string; agentId?: string }): Record<string, string> {
  const params: Record<string, string> = {};
  if (msg.sessionId !== undefined) params['session_id'] = msg.sessionId;
  if (msg.agentId !== undefined) params['agent_id'] = msg.agentId;
  return params;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function withTimeoutWs<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error2(ErrorCodes.INTERNAL, `call timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
