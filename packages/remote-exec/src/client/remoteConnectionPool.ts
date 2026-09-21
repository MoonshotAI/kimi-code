import type { RemoteEnvironment } from './remoteEnvironment';

// A workspace's lease on a pooled connection. `onPoolReplace` is the replace
// broadcast: the entry's connection was swapped by a reconnect from any
// workspace (or by a rebuild after a drop). The holder swaps its view to the
// new connection; turns pinned to the old generation fail explicitly, exactly
// as on a connection drop.
export interface RemoteConnectionPoolHolder {
  readonly onPoolReplace: (connection: RemoteEnvironment) => Promise<void>;
}

export interface RemoteConnectionPoolHandle {
  readonly fingerprint: string;
  // Live read of the entry's installed connection: a pool-level replace
  // swaps it under existing handles.
  readonly connection: RemoteEnvironment;
  release(): void;
}

export class RemoteConnectionPoolStaleError extends Error {
  constructor() {
    super('pooled connection was invalidated while the connect was in flight');
    this.name = 'RemoteConnectionPoolStaleError';
  }
}

interface HolderState {
  active: boolean;
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
      };
      this.entries.set(fingerprint, entry);
    }
    entry.refs += 1;
    const state: HolderState = {
      active: true,
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
    if (entry.refs > 0) return;
    this.invalidate(entry);
    const connection = entry.connection;
    entry.connection = undefined;
    if (connection !== undefined) void connection.dispose();
  }

  private invalidate(entry: PoolEntry): void {
    if (entry.dead) return;
    entry.dead = true;
    entry.version += 1;
    if (this.entries.get(entry.fingerprint) === entry) this.entries.delete(entry.fingerprint);
  }
}
