// src/memory-guard.ts
//
// MiniDb's maxMemory guard as a facet: the LRU access-tracking set, the
// projected-bytes accounting, and the enforce pass (TTL drain → evict-lru →
// reject). Everything it needs from MiniDb is injected through
// MemoryGuardDeps (store/config getters, the stats sink, and the evict
// callback — the WAL commit machinery behind an eviction stays in MiniDb), so
// this module never imports the MiniDb class itself.

import { TYPE_SET } from './codec.js';
import type { Store } from './store.js';
import type { ValueMode } from './recovery.js';
import type { PreparedOp } from './types.js';

/** The owner-injected surface the guard needs (see the header). */
export interface MemoryGuardDeps {
  store: () => Store;
  valueMode: () => ValueMode;
  maxMemoryBytes: () => number | null;
  maxMemoryPolicy: () => 'reject' | 'evict-lru';
  /** The owner's stats object (the guard increments maxMemoryRejections). */
  stats: { maxMemoryRejections: number };
  /** Evict one live key through the owner's write path (a committed DEL). */
  evictKey: (pk: string) => Promise<void>;
}

export class MemoryGuard<V> {
  /** pk, insertion-ordered by last touch (Map/Set iteration order): front =
   *  LRU. Non-private (package-internal by convention): MiniDb forwards its
   *  delete-only access call sites here. */
  readonly access = new Set<string>();

  constructor(private readonly deps: MemoryGuardDeps) {}

  touchAccess(pk: string): void {
    // Re-insert so the iteration order of `access` is LRU..MRU: delete()+add()
    // moves the key to the most-recently-used end (a plain set() on an existing
    // key would keep its old position, which forced O(N) victim scans).
    this.access.delete(pk);
    this.access.add(pk);
  }

  seedAccessFromStore(): void {
    this.access.clear();
    for (const [k] of this.deps.store().map) this.access.add(k);
  }

  projectedBytesForOps(ops: readonly PreparedOp<V>[]): number {
    const store = this.deps.store();
    const considered = new Map<string, number>();
    let projected = store.bytes;
    for (const op of ops) {
      const cur = considered.has(op.pk) ? considered.get(op.pk)! : store.recordBytes(op.pk);
      projected -= cur;
      const next =
        op.type === TYPE_SET
          ? store.estimateSetBytes(op.key, op.value!, op.dtNorm, { countValue: this.deps.valueMode() === 'memory' })
          : 0;
      projected += next;
      considered.set(op.pk, next);
    }
    return projected;
  }

  /** O(1) LRU victim: `access` is insertion-ordered by last touch, so the
   *  first entry that is a live, non-skipped key is the least-recently-used one. */
  pickEvictionVictim(skip: Set<string>): string | undefined {
    const store = this.deps.store();
    for (const k of this.access) {
      if (skip.has(k) || !store.map.has(k)) continue;
      return k;
    }
    for (const [k] of store.map) if (!skip.has(k)) return k;
    return undefined;
  }

  async ensureMemoryFor(ops: readonly PreparedOp<V>[]): Promise<void> {
    const maxMemoryBytes = this.deps.maxMemoryBytes();
    if (maxMemoryBytes === null) return;
    const store = this.deps.store();
    // Drain due TTL entries via the store's expiry heap (O(due)) instead of a
    // full-store sweep on every write.
    store.reapExpiredDue();
    let projected = this.projectedBytesForOps(ops);
    if (projected <= maxMemoryBytes) return;

    if (this.deps.maxMemoryPolicy() === 'evict-lru') {
      const skip = new Set(ops.map((o) => o.pk));
      while (projected > maxMemoryBytes) {
        const victim = this.pickEvictionVictim(skip);
        if (!victim) break;
        projected -= store.recordBytes(victim);
        await this.deps.evictKey(victim);
      }
    }

    if (projected > maxMemoryBytes) {
      this.deps.stats.maxMemoryRejections++;
      throw new Error(`maxMemory exceeded: projected ${projected} bytes > ${maxMemoryBytes} bytes`);
    }
  }
}
