import { TimeoutTimer } from '@moonshot-ai/agent-core-v2/_base/utils/timer';

import type { RemoteEnvironment } from './remoteEnvironment';

// A workspace's lease on a pooled connection. `idle` mirrors the workspace
// registry's idleness (zero active leases and zero tracked resources);
// `ttlMs` is the declaration's idle-reap TTL, where 0 means never reap.
// `onPoolDestroy` fires when the pool reaps the shared connection out from
// under the holder and must settle once the holder dropped its view of the
// connection; the pool disposes the connection afterwards.
export interface RemoteConnectionPoolHolder {
  readonly idle: boolean;
  readonly ttlMs: number;
  readonly onPoolDestroy: (connection: RemoteEnvironment) => Promise<void>;
}

export interface RemoteConnectionPoolHandle {
  readonly fingerprint: string;
  readonly connection: RemoteEnvironment;
  update(state: { readonly idle: boolean; readonly ttlMs: number }): void;
  release(): void;
}

export class RemoteConnectionPoolStaleError extends Error {
  constructor() {
    super('pooled connection was invalidated while the connect was in flight');
    this.name = 'RemoteConnectionPoolStaleError';
  }
}

interface HolderState {
  idle: boolean;
  ttlMs: number;
  active: boolean;
  readonly onPoolDestroy: (connection: RemoteEnvironment) => Promise<void>;
}

interface PoolEntry {
  readonly fingerprint: string;
  // Bumped on every invalidation: a connect that finishes against an older
  // version disposes its result instead of installing it into an entry the
  // pool already tore down.
  version: number;
  dead: boolean;
  refs: number;
  connection?: RemoteEnvironment;
  connectInflight?: Promise<RemoteEnvironment>;
  readonly holders: Set<HolderState>;
  readonly reapTimer: TimeoutTimer;
}

export class RemoteConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();

  async acquire(
    fingerprint: string,
    factory: () => Promise<RemoteEnvironment>,
    holder: RemoteConnectionPoolHolder,
  ): Promise<RemoteConnectionPoolHandle> {
    let entry = this.entries.get(fingerprint);
    if (entry === undefined) {
      entry = {
        fingerprint,
        version: 0,
        dead: false,
        refs: 0,
        holders: new Set(),
        reapTimer: new TimeoutTimer(),
      };
      this.entries.set(fingerprint, entry);
    }
    // Any acquire cancels the idle reap; it re-arms on the next holder update
    // or connection install if every holder is still idle.
    entry.reapTimer.cancel();
    entry.refs += 1;
    const state: HolderState = {
      idle: holder.idle,
      ttlMs: holder.ttlMs,
      active: true,
      onPoolDestroy: holder.onPoolDestroy,
    };
    entry.holders.add(state);
    let connection: RemoteEnvironment;
    try {
      connection = await this.connectionFor(entry, factory);
    } catch (error) {
      entry.holders.delete(state);
      this.releaseRef(entry);
      throw error;
    }
    return {
      fingerprint,
      connection,
      update: (next) => {
        if (!state.active) return;
        state.idle = next.idle;
        state.ttlMs = next.ttlMs;
        this.rearmReap(entry);
      },
      release: () => {
        if (!state.active) return;
        state.active = false;
        entry.holders.delete(state);
        this.releaseRef(entry);
      },
    };
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.invalidate(entry);
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.connectInflight;
      } catch {}
      const connection = entry.connection;
      entry.connection = undefined;
      await connection?.dispose();
    }));
  }

  private connectionFor(
    entry: PoolEntry,
    factory: () => Promise<RemoteEnvironment>,
  ): Promise<RemoteEnvironment> {
    const existing = entry.connection;
    if (existing !== undefined && existing.status === 'ready') return Promise.resolve(existing);
    entry.connectInflight ??= this.runFactory(entry, factory);
    return entry.connectInflight;
  }

  private async runFactory(
    entry: PoolEntry,
    factory: () => Promise<RemoteEnvironment>,
  ): Promise<RemoteEnvironment> {
    const version = entry.version;
    const previous = entry.connection;
    try {
      const connected = await factory();
      if (entry.version !== version) {
        await connected.dispose();
        throw new RemoteConnectionPoolStaleError();
      }
      entry.connection = connected;
      this.rearmReap(entry);
      // The replaced connection died before this connect started; disposing it
      // here mirrors the record-level `await previous?.dispose()` reconnect
      // path without blocking the joiners on a wedged child's teardown.
      if (previous !== undefined) void previous.dispose();
      return connected;
    } finally {
      entry.connectInflight = undefined;
    }
  }

  private releaseRef(entry: PoolEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) {
      this.rearmReap(entry);
      return;
    }
    this.invalidate(entry);
    const connection = entry.connection;
    entry.connection = undefined;
    if (connection !== undefined) void connection.dispose();
  }

  private invalidate(entry: PoolEntry): void {
    if (entry.dead) return;
    entry.dead = true;
    entry.version += 1;
    entry.reapTimer.dispose();
    if (this.entries.get(entry.fingerprint) === entry) this.entries.delete(entry.fingerprint);
  }

  private rearmReap(entry: PoolEntry): void {
    entry.reapTimer.cancel();
    if (entry.dead) return;
    const connection = entry.connection;
    if (connection === undefined || connection.status !== 'ready') return;
    let ttlMs: number | undefined;
    for (const holder of entry.holders) {
      if (!holder.idle) return;
      // A never-reap declaration (TTL 0) wins the min over conflicting TTLs.
      if (holder.ttlMs === 0) return;
      ttlMs = ttlMs === undefined ? holder.ttlMs : Math.min(ttlMs, holder.ttlMs);
    }
    if (ttlMs === undefined) return;
    entry.reapTimer.cancelAndSet(() => {
      void this.reap(entry);
    }, ttlMs);
  }

  private async reap(entry: PoolEntry): Promise<void> {
    const connection = entry.connection;
    if (entry.dead || connection === undefined || connection.status !== 'ready') return;
    for (const holder of entry.holders) {
      if (!holder.idle) return;
    }
    this.invalidate(entry);
    const holders = [...entry.holders];
    entry.holders.clear();
    for (const holder of holders) holder.active = false;
    await Promise.all(holders.map((holder) => holder.onPoolDestroy(connection).catch(() => {})));
    await connection.dispose();
  }
}
