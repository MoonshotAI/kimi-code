import { TimeoutTimer } from '@moonshot-ai/agent-core-v2/_base/utils/timer';

import type { RemoteEnvironment } from './remoteEnvironment';

// A workspace's lease on a pooled connection. `idle` mirrors the workspace
// registry's idleness (zero active leases and zero tracked resources);
// `ttlMs` is the declaration's idle-reap TTL, where 0 means never reap.
export interface RemoteConnectionPoolHolder {
  readonly idle: boolean;
  readonly ttlMs: number;
  // Reap vote: once every holder stayed idle for the TTL the pool asks each
  // holder to drop its view of the connection. Return true once the view is
  // dropped (or was never installed); return false to veto the reap — a
  // lease landed in the reap window and the connection must survive. A veto
  // keeps the entry alive; views already dropped rejoin the surviving
  // connection on their next connect.
  readonly onPoolDestroy: (connection: RemoteEnvironment) => Promise<boolean>;
  // Replace broadcast: the entry's connection was swapped by a reconnect
  // from any workspace (or by a rebuild after a drop). The holder swaps its
  // view to the new connection; turns pinned to the old generation fail
  // explicitly, exactly as on a connection drop.
  readonly onPoolReplace: (connection: RemoteEnvironment) => Promise<void>;
}

export interface RemoteConnectionPoolHandle {
  readonly fingerprint: string;
  // Live read of the entry's installed connection: a pool-level replace
  // swaps it under existing handles.
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
  readonly onPoolDestroy: (connection: RemoteEnvironment) => Promise<boolean>;
  readonly onPoolReplace: (connection: RemoteEnvironment) => Promise<void>;
}

interface PoolEntry {
  readonly fingerprint: string;
  // Bumped on every invalidation and every replace: a connect that finishes
  // against an older version disposes its result instead of installing it
  // into an entry that already moved on.
  version: number;
  dead: boolean;
  refs: number;
  connection?: RemoteEnvironment;
  connectInflight?: Promise<RemoteEnvironment>;
  // The entry version the in-flight connect installs against. Once the
  // version moves past it the run is stale: new callers start a fresh run
  // instead of joining, and the stale run's install is rejected.
  connectInflightVersion?: number;
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
      onPoolReplace: holder.onPoolReplace,
    };
    entry.holders.add(state);
    try {
      await this.connectionFor(entry, factory);
    } catch (error) {
      entry.holders.delete(state);
      this.releaseRef(entry);
      throw error;
    }
    return {
      fingerprint,
      get connection() {
        return entry.connection as RemoteEnvironment;
      },
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

  // Coordinated reconnect: supersede the entry's current connection and drive
  // one factory run for its replacement. A concurrent replace (or a rebuild
  // already running against the current version) is joined instead of driving
  // a second run. Once the new connection installs, every holder's
  // `onPoolReplace` broadcast swaps its workspace view.
  async replace(fingerprint: string, factory: () => Promise<RemoteEnvironment>): Promise<RemoteEnvironment> {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined || entry.dead) throw new RemoteConnectionPoolStaleError();
    entry.reapTimer.cancel();
    const inflight = entry.connectInflight;
    if (inflight !== undefined && entry.connectInflightVersion === entry.version) return inflight;
    entry.version += 1;
    return this.startConnect(entry, factory);
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
    const inflight = entry.connectInflight;
    if (inflight !== undefined && entry.connectInflightVersion === entry.version) return inflight;
    return this.startConnect(entry, factory);
  }

  private startConnect(
    entry: PoolEntry,
    factory: () => Promise<RemoteEnvironment>,
  ): Promise<RemoteEnvironment> {
    const version = entry.version;
    const run = this.runFactory(entry, version, factory);
    entry.connectInflight = run;
    entry.connectInflightVersion = version;
    void run.catch(() => {}).then(() => {
      if (entry.connectInflight === run) {
        entry.connectInflight = undefined;
        entry.connectInflightVersion = undefined;
      }
    });
    return run;
  }

  private async runFactory(
    entry: PoolEntry,
    version: number,
    factory: () => Promise<RemoteEnvironment>,
  ): Promise<RemoteEnvironment> {
    const previous = entry.connection;
    const connected = await factory();
    if (entry.version !== version) {
      await connected.dispose();
      throw new RemoteConnectionPoolStaleError();
    }
    entry.connection = connected;
    this.rearmReap(entry);
    if (previous !== undefined) {
      // The swap broadcasts before the replaced connection dies: every
      // workspace view moves to the new connection first, then the old one
      // is disposed. Leases pinned to an old generation fail through the
      // registry drain and their dead connection, exactly like a drop.
      void this.broadcastReplace(entry, connected).then(
        () => previous.dispose(),
        () => previous.dispose(),
      );
    }
    return connected;
  }

  private async broadcastReplace(entry: PoolEntry, connection: RemoteEnvironment): Promise<void> {
    await Promise.all([...entry.holders].map(async (holder) => {
      if (!holder.active) return;
      try {
        await holder.onPoolReplace(connection);
      } catch {}
    }));
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
    // A connect or replace in flight is activity: skip this round.
    if (entry.connectInflight !== undefined) {
      this.rearmReap(entry);
      return;
    }
    for (const holder of entry.holders) {
      if (!holder.idle) return;
    }
    // Two-phase vote: every holder drops its view of the connection and
    // votes. A false vote means a lease landed in the reap window, so the
    // connection survives — views already dropped rejoin it on their next
    // connect, exactly like a first connect.
    const votes = await Promise.all([...entry.holders].map(async (holder) => {
      if (!holder.active) return true;
      return holder.onPoolDestroy(connection).catch(() => false);
    }));
    if (votes.includes(false) || entry.dead || entry.connection !== connection) {
      this.rearmReap(entry);
      return;
    }
    this.invalidate(entry);
    // Every vote dropped its view: deactivate whatever did not release during
    // the vote so later handle calls no-op, then tear the connection down.
    for (const holder of entry.holders) holder.active = false;
    entry.holders.clear();
    entry.connection = undefined;
    await connection.dispose();
  }
}
