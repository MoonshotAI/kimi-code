/**
 * `connection-registry` transport module — server-local registry of live
 * WebSocket connections.
 *
 * Backs `GET /api/v1/connections`. Holds both `/api/v1/ws` (v1 protocol) and
 * `/api/v2/ws` (v2 RPC) connections through the common {@link ConnectionLike}
 * shape. Mirrors v1's `IConnectionRegistry`
 * (`packages/server/src/services/gateway`).
 *
 * Owned by the server bootstrap (`start.ts`) and passed by parameter to the WS
 * layers and the route. It is intentionally NOT registered into the
 * `agent-core-v2` Core `Scope`: the registry is transport state, not a business
 * service, so it carries no `_serviceBrand` and is not DI-managed.
 */

/**
 * Common shape of a WebSocket connection tracked by the registry — the fields
 * the `GET /api/v1/connections` route projects onto the wire. Both the v1
 * (`WsConnectionV1`) and v2 (`WsConnection`) connections satisfy this.
 */
export interface ConnectionLike {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly hasClientHello: boolean;
  readonly subscriptionSessionIds: readonly string[];
  close(code?: number, reason?: string): void;
}

export interface IConnectionRegistry {
  /** Insert a freshly-accepted connection. */
  add(conn: ConnectionLike): void;
  /** Remove a closed connection. Idempotent. */
  remove(connId: string): void;
  /** Look up by id. */
  get(connId: string): ConnectionLike | undefined;
  /** Iterate all currently-attached connections. */
  values(): Iterable<ConnectionLike>;
  /** Close every attached connection (used on shutdown). */
  closeAll(reason?: string): void;
  /** Number of currently-attached connections. */
  size(): number;
}

export class ConnectionRegistry implements IConnectionRegistry {
  private readonly conns = new Map<string, ConnectionLike>();

  add(conn: ConnectionLike): void {
    this.conns.set(conn.id, conn);
  }

  remove(connId: string): void {
    this.conns.delete(connId);
  }

  get(connId: string): ConnectionLike | undefined {
    return this.conns.get(connId);
  }

  values(): Iterable<ConnectionLike> {
    return this.conns.values();
  }

  closeAll(reason?: string): void {
    const snapshot = Array.from(this.conns.values());
    this.conns.clear();
    for (const conn of snapshot) {
      try {
        conn.close(1001, reason);
      } catch {
        // best-effort cleanup on shutdown
      }
    }
  }

  size(): number {
    return this.conns.size;
  }
}
