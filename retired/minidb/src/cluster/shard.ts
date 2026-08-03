// src/cluster/shard.ts
//
// A single shard: one MiniDb instance in either writer mode (holding the
// shard's db.lock, with a lease timer refreshing the lock timestamp) or
// reader mode (read-only, no lock, coexisting with another process's writer).

import { MiniDb } from '../index.js';
import type { OpenOptions } from '../index.js';

/** MiniDb options for a shard open; everything except the identity fields. */
export type ShardOpenOptions = Omit<OpenOptions, 'dir' | 'readOnly' | 'onLockFail'>;

export class ShardHandle {
  private leaseTimer: NodeJS.Timeout | null = null;

  private constructor(
    readonly shardId: number,
    readonly dir: string,
    readonly db: MiniDb<unknown>,
    readonly writer: boolean,
  ) {}

  /** Open the shard for writing: acquires db.lock via MiniDb.open and starts
   *  refreshing the lock timestamp every renewMs (0 disables renewal). Throws
   *  LockError if the lock is held by a live process. */
  static async openWriter(
    shardId: number,
    dir: string,
    opts: ShardOpenOptions,
    renewMs: number,
  ): Promise<ShardHandle> {
    const db = await MiniDb.open({ ...opts, dir });
    const handle = new ShardHandle(shardId, dir, db as MiniDb<unknown>, true);
    if (renewMs > 0) {
      handle.leaseTimer = setInterval(() => {
        void db.renewLock().catch(() => {});
      }, renewMs);
      // Never keep a worker process alive just for lease renewal.
      handle.leaseTimer.unref();
    }
    return handle;
  }

  /** Open the shard read-only. Does not touch db.lock, never fsyncs, and
   *  never auto-compacts (a read-only open must not rewrite a live writer's
   *  directory). */
  static async openReader(shardId: number, dir: string, opts: ShardOpenOptions): Promise<ShardHandle> {
    const db = await MiniDb.open({
      ...opts,
      dir,
      readOnly: true,
      autoCompact: false,
      fsyncPolicy: 'no',
    });
    return new ShardHandle(shardId, dir, db as MiniDb<unknown>, false);
  }

  async close(): Promise<void> {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    await this.db.close();
  }
}
