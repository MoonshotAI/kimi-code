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
  add(conn: ConnectionLike): void;
  remove(connId: string): void;
  get(connId: string): ConnectionLike | undefined;
  values(): Iterable<ConnectionLike>;
  closeAll(reason?: string): void;
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
