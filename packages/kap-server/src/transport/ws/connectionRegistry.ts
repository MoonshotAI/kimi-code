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
      }
    }
  }

  size(): number {
    return this.conns.size;
  }
}
