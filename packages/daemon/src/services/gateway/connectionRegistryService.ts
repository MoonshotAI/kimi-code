/**
 * `ConnectionRegistry` — implementation of `IConnectionRegistry`.
 */

import { Disposable } from '@moonshot-ai/agent-core';

import type { WsConnection } from '#/ws/connection';
import { IConnectionRegistry } from './connectionRegistry';

export class ConnectionRegistry extends Disposable implements IConnectionRegistry {
  readonly _serviceBrand: undefined;

  private readonly _conns = new Map<string, WsConnection>();

  add(c: WsConnection): void {
    this._conns.set(c.id, c);
  }

  remove(id: string): void {
    this._conns.delete(id);
  }

  get(id: string): WsConnection | undefined {
    return this._conns.get(id);
  }

  values(): Iterable<WsConnection> {
    return this._conns.values();
  }

  closeAll(reason = 'daemon shutting down'): void {
    // Snapshot first — `close(...)` triggers the WS `'close'` listener which
    // calls `remove(...)` on this registry, mutating `_conns` mid-iteration.
    const snapshot = Array.from(this._conns.values());
    this._conns.clear();
    for (const c of snapshot) {
      try {
        c.close(1001, reason);
      } catch {
        // ignore — defensive teardown
      }
    }
  }

  size(): number {
    return this._conns.size;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // Belt-and-suspenders: WSGateway.dispose() already called closeAll().
    // Idempotent.
    this.closeAll();
    super.dispose();
  }
}
