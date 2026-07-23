// src/cluster/shard.ts
//
// A single shard: one MiniDb instance in either writer mode (holding the
// shard's kernel-backed db.lock) or
// reader mode (read-only, no lock, coexisting with another process's writer).

import { MiniDb } from '../index.js';
import type { OpenOptions } from '../index.js';

/** MiniDb options for a shard open; everything except the identity fields. */
export type ShardOpenOptions = Omit<OpenOptions, 'dir' | 'readOnly' | 'onLockFail'>;

export class ShardHandle {
  private constructor(
    readonly shardId: number,
    readonly dir: string,
    readonly db: MiniDb<unknown>,
    readonly writer: boolean,
  ) {}

  /** Open the shard for writing and hold db.lock until close. */
  static async openWriter(
    shardId: number,
    dir: string,
    opts: ShardOpenOptions,
  ): Promise<ShardHandle> {
    const db = await MiniDb.open({ ...opts, dir });
    return new ShardHandle(shardId, dir, db as MiniDb<unknown>, true);
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
    await this.db.close();
  }
}
