// src/cluster/coordinator.ts
//
// Cross-shard write coordination. Ops are grouped by shard; groups are
// executed in ascending shard-id order (the fixed lock-acquisition order that
// avoids deadlocks between processes). Within one shard the group commits as
// a single MiniDb batch (one WAL frame, all-or-nothing); across shards the
// semantics depend on the configured CrossShardMode.

import type { BatchInputOp, MiniDb } from '../index.js';
import type { CrossShardMode } from './types.js';
import type { Router } from './router.js';

export class Coordinator<V = unknown> {
  constructor(
    private readonly router: Router,
    private readonly runOnShard: <T>(shardId: number, fn: (db: MiniDb<V>) => T | Promise<T>) => Promise<T>,
    private readonly mode: CrossShardMode,
  ) {}

  private checkMode(shardIds: number[]): void {
    if (shardIds.length <= 1) return;
    if (this.mode === 'none') {
      throw new Error(`operation spans ${shardIds.length} shards but crossShard mode is 'none'`);
    }
    if (this.mode === '2pc') {
      throw new Error("crossShard mode '2pc' is reserved but not implemented yet");
    }
  }

  /** Group items by their key's shard, shards in ascending id order. */
  private group<T>(items: readonly T[], keyOf: (item: T) => string): [number, T[]][] {
    const byShard = new Map<number, T[]>();
    for (const item of items) {
      const id = this.router.shardFor(keyOf(item));
      const arr = byShard.get(id);
      if (arr) arr.push(item);
      else byShard.set(id, [item]);
    }
    return [...byShard.entries()].sort((a, b) => a[0] - b[0]);
  }

  private async runGroups<T>(
    groups: [number, T[]][],
    run: (shardId: number, items: T[]) => Promise<void>,
    opName: string,
  ): Promise<void> {
    this.checkMode(groups.map(([id]) => id));
    const errors: unknown[] = [];
    for (const [id, items] of groups) {
      try {
        await run(id, items);
      } catch (e) {
        // best-effort: earlier groups may be committed already; report, don't hide.
        errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${opName} failed on ${errors.length}/${groups.length} shard(s); partial writes possible`);
    }
  }

  /** Multi-shard mset. Atomic within each shard (single WAL batch frame). */
  async mset(entries: readonly (readonly [string, V])[]): Promise<void> {
    const groups = this.group(entries, ([key]) => key);
    await this.runGroups(
      groups,
      (id, items) =>
        this.runOnShard(id, (db) => db.batch(items.map(([key, value]) => ({ op: 'set' as const, key, value })))),
      'mset',
    );
  }

  /** Multi-shard delete. Returns the number of keys that actually existed. */
  async mdel(keys: readonly string[]): Promise<number> {
    const groups = this.group(keys, (k) => k);
    this.checkMode(groups.map(([id]) => id));
    let removed = 0;
    const errors: unknown[] = [];
    for (const [id, ks] of groups) {
      try {
        removed += await this.runOnShard(id, async (db) => {
          const existing = ks.filter((k) => db.has(k));
          if (existing.length > 0) await db.batch(existing.map((key) => ({ op: 'del' as const, key })));
          return existing.length;
        });
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `mdel failed on ${errors.length}/${groups.length} shard(s); partial writes possible`);
    }
    return removed;
  }

  /** Multi-shard atomic-per-shard batch (set/del ops with optional ttl/dt). */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    const groups = this.group(ops, (op) => op.key);
    await this.runGroups(groups, (id, items) => this.runOnShard(id, (db) => db.batch(items)), 'batch');
  }
}
