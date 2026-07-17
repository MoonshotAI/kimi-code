// src/cluster/index.ts
//
// ClusterDb: a logically single MiniDb database sharded into N independent
// MiniDb directories so multiple processes can read and write concurrently.
//
//  - Placement is a pure hash (see router.ts): every process agrees on the
//    shard for a key without coordination.
//  - Each shard keeps minidb's single-writer model (its own db.lock), so
//    concurrency scales with the number of distinct shards being written.
//  - Writes route through a per-process writer pool (lock-pool.ts): cached
//    shard writers hold their lock and renew its timestamp; acquisition
//    retries live holders up to lockAcquireTimeoutMs.
//  - Reads never take write locks: they use the cached writer when this
//    process holds the shard, else a read-only MiniDb revalidated against
//    the shard files' fingerprint on every use.
//  - Index definitions live in a cluster-wide registry (cluster.indexes.json)
//    as the source of truth; every shard writer applies missing definitions
//    right after opening, and create/drop operations fan out to all shards.
//
// Consistency: single-key and same-shard batch ops are strongly consistent
// (single writer per shard, atomic WAL frames). Cross-shard mset/mdel/batch
// are best-effort (atomic per shard, not globally). scan/prefix results are a
// per-shard snapshot merged globally, so entries from different shards may
// reflect different points in time.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { BatchInputOp, IndexDef, IndexInfo, MiniDb, ScanEntry, SetOptions } from '../index.js';
import { LockError } from '../lockfile.js';
import { Coordinator } from './coordinator.js';
import { ShardLockPool } from './lock-pool.js';
import { Router } from './router.js';
import { Topology } from './topology.js';
import type {
  ClusterIndexRegistry,
  ClusterOpenOptions,
  ClusterStats,
  CompactResult,
  ScanOptions,
} from './types.js';
import { CLUSTER_INDEX_FILE, sleep } from './utils.js';

export type {
  ClusterIndexRegistry,
  ClusterMeta,
  ClusterOpenOptions,
  ClusterStats,
  CompactResult,
  CrossShardMode,
  ScanOptions,
} from './types.js';
export { Router } from './router.js';
export { Topology } from './topology.js';
export { LockError } from '../lockfile.js';
export type { ShardOpenOptions } from './shard.js';
export { shardDirName, shardFor, stableHash32 } from './utils.js';

/** Compare ScanEntry keys by UTF-8 byte order, matching the per-shard store
 *  ordering so a globally sorted merge is consistent with local scans. */
function compareEntries<V>(a: ScanEntry<V>, b: ScanEntry<V>): number {
  return Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8'));
}

export class ClusterDb<V = unknown> {
  private closed = false;

  private constructor(
    private readonly topology: Topology,
    private readonly router: Router,
    private readonly pool: ShardLockPool,
    private readonly coordinator: Coordinator<V>,
    private readonly indexPath: string,
    readonly readOnly: boolean,
  ) {}

  static async open<V = unknown>(opts: ClusterOpenOptions): Promise<ClusterDb<V>> {
    if (!opts || !opts.dir) throw new TypeError('ClusterDb.open: opts.dir is required');
    if ((opts.crossShard ?? 'best-effort') === '2pc') {
      throw new Error("crossShard: '2pc' is reserved for a future release and is not implemented yet");
    }
    const topology = await Topology.open(opts.dir, opts);
    await topology.ensureShardDirs();
    const router = new Router(opts.dir, topology.meta);
    const readOnly = !!opts.readOnly;
    const indexPath = path.join(opts.dir, CLUSTER_INDEX_FILE);

    const pool = new ShardLockPool({
      writerOpts: {
        valueCodec: topology.meta.valueCodec,
        fsyncPolicy: topology.meta.fsyncPolicy,
        valueMode: opts.valueMode,
        compactThresholdBytes: opts.compactThresholdBytes,
        autoCompact: opts.autoCompact,
        activeExpireIntervalMs: opts.activeExpireIntervalMs,
        recovery: opts.recovery,
        maxMemoryBytes: opts.maxMemoryBytes,
        maxMemoryPolicy: opts.maxMemoryPolicy,
      },
      readerOpts: {
        valueCodec: topology.meta.valueCodec,
        valueMode: opts.valueMode,
        recovery: opts.recovery,
      },
      lockRenewMs: opts.lockRenewMs ?? 10_000,
      lockAcquireTimeoutMs: opts.lockAcquireTimeoutMs ?? 30_000,
      lockHoldMs: opts.lockHoldMs ?? 250,
      maxWriters: opts.lockPoolMaxShards ?? 16,
      maxReaders: opts.readersMaxShards ?? topology.shardCount,
      readOnly,
      applyDefs: async (db) => {
        const reg = await ClusterDb.loadRegistry(indexPath);
        for (const { name, def } of reg.indexes) {
          if (!db.listIndexes().some((i) => i.name === name)) await db.createIndex(name, def);
        }
        for (const { name, fields } of reg.textIndexes) {
          try {
            await db.createTextIndex(name, { fields: fields ?? undefined });
          } catch (e) {
            // Idempotent apply: the def may already exist on this shard.
            if (!(e instanceof Error) || !e.message.includes('already exists')) throw e;
          }
        }
      },
    });
    const coordinator = new Coordinator<V>(
      router,
      (shardId, fn) => pool.withWriter(shardId, router.shardDir(shardId), (db) => fn(db as MiniDb<V>)),
      opts.crossShard ?? 'best-effort',
    );
    return new ClusterDb<V>(topology, router, pool, coordinator, indexPath, readOnly);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('ClusterDb is closed');
  }

  get dir(): string {
    return this.topology.dir;
  }

  get shardCount(): number {
    return this.router.shardCount;
  }

  /** Which shard a key lives on. */
  shardOf(key: string): number {
    return this.router.shardFor(key);
  }

  private writer<T>(shardId: number, fn: (db: MiniDb<V>) => T | Promise<T>): Promise<T> {
    return this.pool.withWriter(shardId, this.router.shardDir(shardId), (db) => fn(db as MiniDb<V>));
  }

  private reader<T>(shardId: number, fn: (db: MiniDb<V>) => T | Promise<T>): Promise<T> {
    return this.pool.withReader(shardId, this.router.shardDir(shardId), (db) => fn(db as MiniDb<V>));
  }

  // ---- single-key ops -------------------------------------------------------

  async get(key: string): Promise<V | undefined> {
    this.ensureOpen();
    return this.reader(this.router.shardFor(key), (db) => db.get(key));
  }

  async set(key: string, value: V, opts?: SetOptions): Promise<void> {
    this.ensureOpen();
    await this.writer(this.router.shardFor(key), (db) => db.set(key, value, opts));
  }

  async del(key: string): Promise<boolean> {
    this.ensureOpen();
    return this.writer(this.router.shardFor(key), (db) => db.del(key));
  }

  async has(key: string): Promise<boolean> {
    this.ensureOpen();
    return this.reader(this.router.shardFor(key), (db) => db.has(key));
  }

  /** Remaining TTL in ms; -2 when the key does not exist, -1 when it has no TTL. */
  async ttl(key: string): Promise<number> {
    this.ensureOpen();
    return this.reader(this.router.shardFor(key), (db) => db.ttl(key));
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    this.ensureOpen();
    return this.writer(this.router.shardFor(key), (db) => db.expire(key, ttlMs));
  }

  // ---- multi-key ops --------------------------------------------------------

  async mget(keys: readonly string[]): Promise<(V | undefined)[]> {
    this.ensureOpen();
    const out = Array.from<V | undefined>({ length: keys.length });
    const groups = new Map<number, { key: string; idx: number }[]>();
    keys.forEach((key, idx) => {
      const id = this.router.shardFor(key);
      const group = groups.get(id);
      if (group) group.push({ key, idx });
      else groups.set(id, [{ key, idx }]);
    });
    for (const [id, items] of groups) {
      await this.reader(id, (db) => {
        for (const { key, idx } of items) out[idx] = db.get(key);
      });
    }
    return out;
  }

  /** Atomic per shard; best-effort across shards (see CrossShardMode). */
  async mset(entries: readonly (readonly [string, V])[]): Promise<void> {
    this.ensureOpen();
    await this.coordinator.mset(entries);
  }

  /** Returns the number of keys that existed and were deleted. */
  async mdel(keys: readonly string[]): Promise<number> {
    this.ensureOpen();
    return this.coordinator.mdel(keys);
  }

  /** Atomic per shard (single WAL batch frame); best-effort across shards. */
  async batch(ops: readonly BatchInputOp<V>[]): Promise<void> {
    this.ensureOpen();
    await this.coordinator.batch(ops);
  }

  // ---- scans ----------------------------------------------------------------

  /** Merged scan over all shards, sorted by key bytes. Hash sharding means
   *  every range scan fans out to all shards; entries are materialized,
   *  merged, then limited. */
  async scan(opts: ScanOptions = {}): Promise<ScanEntry<V>[]> {
    this.ensureOpen();
    // A reverse scan must see the tail per shard, so per-shard limits only
    // apply to forward scans; slicing happens after the global merge either way.
    const perShardLimit = opts.reverse ? Infinity : (opts.limit ?? Infinity);
    const range = { gte: opts.gte, gt: opts.gt, lte: opts.lte, lt: opts.lt, count: perShardLimit };
    const usePrefix = opts.prefix !== undefined;
    const all: ScanEntry<V>[] = [];
    for (const id of this.router.shardIds()) {
      const entries = await this.reader(id, (db) =>
        usePrefix ? db.prefix(opts.prefix!, perShardLimit) : db.scan(range),
      );
      for (const e of entries) all.push(e);
    }
    all.sort(compareEntries);
    if (opts.reverse) all.reverse();
    const limit = opts.limit ?? Infinity;
    return limit === Infinity ? all : all.slice(0, limit);
  }

  async prefix(p: string, limit = Infinity): Promise<ScanEntry<V>[]> {
    return this.scan({ prefix: p, limit });
  }

  // ---- secondary indexes ------------------------------------------------------

  private static async loadRegistry(file: string): Promise<ClusterIndexRegistry> {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ClusterIndexRegistry>;
      return { indexes: raw.indexes ?? [], textIndexes: raw.textIndexes ?? [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { indexes: [], textIndexes: [] };
      throw e;
    }
  }

  private static async saveRegistry(file: string, reg: ClusterIndexRegistry): Promise<void> {
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(reg, null, 2));
    await fs.rename(tmp, file);
  }

  /** Compare two index definitions by their effective values (defaults
   *  applied), so a raced create of the same definition is a no-op while a
   *  genuinely different one keeps the "already exists" error. */
  private static sameIndexDef(a: IndexDef, b: IndexDef): boolean {
    return (
      a.field === b.field &&
      (a.type ?? 'equality') === (b.type ?? 'equality') &&
      !!a.unique === !!b.unique &&
      (a.sparse ?? true) === (b.sparse ?? true)
    );
  }

  /** Per-process serialization of registry read-modify-publish cycles, keyed
   *  by registry file. Cross-process safety comes from the CAS loop in
   *  mutateRegistry; this only keeps ClusterDb instances in THIS process from
   *  interleaving their load/save/verify steps. */
  private static readonly registryLocks = new Map<string, Promise<void>>();

  private static async withRegistryLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = ClusterDb.registryLocks.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => current);
    ClusterDb.registryLocks.set(file, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (ClusterDb.registryLocks.get(file) === tail) ClusterDb.registryLocks.delete(file);
    }
  }

  /** Publish one registry mutation as a compare-and-swap loop: every attempt
   *  re-loads the registry, re-applies the mutation idempotently
   *  (append-if-absent for creates, remove-if-present for drops; mutate
   *  returns false when the effect is already there, ending the loop),
   *  writes via tmp+rename, and accepts the write only when a post-save
   *  re-read still equals what was published. A concurrent rename from
   *  another process fails that check, so the attempt is retried with
   *  jittered backoff. */
  private async mutateRegistry(mutate: (reg: ClusterIndexRegistry) => boolean): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const done = await ClusterDb.withRegistryLock(this.indexPath, async () => {
        const reg = await ClusterDb.loadRegistry(this.indexPath);
        if (!mutate(reg)) return true; // The effect is already published.
        const published = JSON.stringify(reg);
        await ClusterDb.saveRegistry(this.indexPath, reg);
        const reread = await ClusterDb.loadRegistry(this.indexPath);
        return JSON.stringify(reread) === published;
      });
      if (done) return;
      if (attempt >= 19) throw new Error('cluster index registry update keeps losing write races; retry the operation');
      await sleep(10 + Math.floor(Math.random() * 41));
    }
  }

  private requireJsonCodec(what: string): void {
    if (this.topology.meta.valueCodec !== 'json') {
      throw new Error(`${what} require valueCodec: "json"`);
    }
  }

  /** Run fn against a writer of every shard in ascending id order. Index
   *  management needs this so definitions stay consistent cluster-wide; it
   *  waits (up to lockAcquireTimeoutMs per shard) for shards held by other
   *  processes and throws LockError when they cannot be acquired in time. */
  private async forEachShardWriter(fn: (db: MiniDb<V>, shardId: number) => void | Promise<void>): Promise<void> {
    for (const id of this.router.shardIds()) {
      await this.writer(id, (db) => fn(db, id));
    }
  }

  /** Best-effort cleanup after a failed index fan-out: run fn on the shards
   *  the fan-out had completed on, swallowing errors (a shard that cannot be
   *  re-acquired is left as-is). */
  private async rollbackShards(shardIds: number[], fn: (db: MiniDb<V>) => void | Promise<void>): Promise<void> {
    for (const id of shardIds) {
      try {
        await this.writer(id, fn);
      } catch {
        // Best effort only; the original fan-out error is what propagates.
      }
    }
  }

  /** Create a secondary index on every shard and record it in the cluster
   *  registry. Applies to existing data (per-shard backfill) and is picked up
   *  by future shard opens via the registry. */
  async createIndex(name: string, def: IndexDef): Promise<void> {
    this.ensureOpen();
    this.requireJsonCodec('secondary indexes');
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    if (reg.indexes.some((i) => i.name === name)) throw new Error(`index "${name}" already exists`);
    const createdOn: number[] = [];
    try {
      await this.forEachShardWriter(async (db, shardId) => {
        if (!db.listIndexes().some((i) => i.name === name)) {
          await db.createIndex(name, def);
          createdOn.push(shardId);
        }
      });
    } catch (e) {
      // Roll back the partial fan-out: drop the index from exactly the shards
      // this call created it on, so no shard keeps enforcing an index the
      // registry never recorded.
      await this.rollbackShards(createdOn, async (db) => {
        await db.dropIndex(name);
      });
      throw e;
    }
    await this.mutateRegistry((current) => {
      const existing = current.indexes.find((i) => i.name === name);
      if (existing) {
        // A raced create of the same definition already published.
        if (ClusterDb.sameIndexDef(existing.def, def)) return false;
        throw new Error(`index "${name}" already exists`);
      }
      current.indexes.push({ name, def });
      return true;
    });
  }

  async dropIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    const existed = reg.indexes.some((i) => i.name === name);
    await this.forEachShardWriter(async (db) => {
      if (db.listIndexes().some((i) => i.name === name)) await db.dropIndex(name);
    });
    if (!existed) return false;
    await this.mutateRegistry((current) => {
      if (!current.indexes.some((i) => i.name === name)) return false;
      current.indexes = current.indexes.filter((i) => i.name !== name);
      return true;
    });
    return true;
  }

  /** Cluster-wide index definitions from the registry (source of truth). */
  async listIndexes(): Promise<IndexInfo[]> {
    this.ensureOpen();
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    return reg.indexes.map(({ name, def }) => ({
      name,
      field: def.field,
      type: def.type ?? 'equality',
      unique: !!def.unique,
      sparse: !!def.sparse,
    }));
  }

  async findEq(name: string, value: unknown): Promise<{ key: string; value: V | undefined }[]> {
    this.ensureOpen();
    await this.requireIndex(name);
    const out: { key: string; value: V | undefined }[] = [];
    for (const id of this.router.shardIds()) {
      const rows = await this.reader(id, (db) =>
        db.listIndexes().some((i) => i.name === name) ? db.findEq(name, value) : [],
      );
      out.push(...rows);
    }
    out.sort((a, b) => compareEntries({ key: a.key, value: a.value }, { key: b.key, value: b.value }));
    return out;
  }

  async findRange(
    name: string,
    opts: Parameters<MiniDb<V>['findRange']>[1],
  ): Promise<{ key: string; value: V | undefined; field: number }[]> {
    this.ensureOpen();
    await this.requireIndex(name);
    // Only the numeric bounds go to the shards; offset/count/reverse must
    // apply to the globally merged result, not per shard.
    const bounds = { min: opts?.min, max: opts?.max, minExclusive: opts?.minExclusive, maxExclusive: opts?.maxExclusive };
    const out: { key: string; value: V | undefined; field: number }[] = [];
    for (const id of this.router.shardIds()) {
      const rows = await this.reader(id, (db) =>
        db.listIndexes().some((i) => i.name === name) ? db.findRange(name, bounds) : [],
      );
      out.push(...rows);
    }
    out.sort((a, b) => a.field - b.field || compareEntries({ key: a.key, value: a.value }, { key: b.key, value: b.value }));
    if (opts?.reverse) out.reverse();
    const offset = opts?.offset ?? 0;
    const sliced = offset > 0 ? out.slice(offset) : out;
    return opts?.count === undefined ? sliced : sliced.slice(0, opts.count);
  }

  private async requireIndex(name: string): Promise<void> {
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    if (!reg.indexes.some((i) => i.name === name)) throw new Error(`no such index: ${name}`);
  }

  // ---- full-text search -------------------------------------------------------

  async createTextIndex(name: string, opts: { fields?: readonly string[] } = {}): Promise<void> {
    this.ensureOpen();
    this.requireJsonCodec('text indexes');
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    if (reg.textIndexes.some((t) => t.name === name)) throw new Error(`text index "${name}" already exists`);
    const createdOn: number[] = [];
    try {
      await this.forEachShardWriter(async (db, shardId) => {
        try {
          await db.createTextIndex(name, opts);
          createdOn.push(shardId);
        } catch (e) {
          if (!(e instanceof Error) || !e.message.includes('already exists')) throw e;
        }
      });
    } catch (e) {
      // Roll back the partial fan-out: drop the text index only from the
      // shards this call created it on (see createIndex).
      await this.rollbackShards(createdOn, async (db) => {
        await db.dropTextIndex(name);
      });
      throw e;
    }
    const fields = opts.fields ?? null;
    await this.mutateRegistry((current) => {
      if (current.textIndexes.some((t) => t.name === name)) return false; // A raced create already published.
      current.textIndexes.push({ name, fields });
      return true;
    });
  }

  async dropTextIndex(name: string): Promise<boolean> {
    this.ensureOpen();
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    const existed = reg.textIndexes.some((t) => t.name === name);
    await this.forEachShardWriter(async (db) => {
      try {
        await db.dropTextIndex(name);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('no such text index')) throw e;
      }
    });
    if (!existed) return false;
    await this.mutateRegistry((current) => {
      if (!current.textIndexes.some((t) => t.name === name)) return false;
      current.textIndexes = current.textIndexes.filter((t) => t.name !== name);
      return true;
    });
    return existed;
  }

  /** Search every shard and merge by score (desc), key (asc). Scores are
   *  computed per shard (per-shard idf), so global ranking is approximate. */
  async search(name: string, q: string, opts: { op?: 'AND' | 'OR'; limit?: number } = {}): Promise<{ key: string; value: V | undefined; score: number }[]> {
    this.ensureOpen();
    const reg = await ClusterDb.loadRegistry(this.indexPath);
    if (!reg.textIndexes.some((t) => t.name === name)) throw new Error(`no such text index: ${name}`);
    const out: { key: string; value: V | undefined; score: number }[] = [];
    for (const id of this.router.shardIds()) {
      const rows = await this.reader(id, (db) => {
        try {
          return db.search(name, q, opts);
        } catch (e) {
          if (e instanceof Error && e.message.includes('no such text index')) return [];
          throw e;
        }
      });
      out.push(...rows);
    }
    out.sort((a, b) => b.score - a.score || compareEntries({ key: a.key, value: a.value }, { key: b.key, value: b.value }));
    return opts.limit === undefined ? out : out.slice(0, opts.limit);
  }

  // ---- maintenance ------------------------------------------------------------

  /** Compact every shard this process can acquire. Shards whose write lock is
   *  held elsewhere (beyond lockAcquireTimeoutMs) are skipped, not errored. */
  async compact(): Promise<CompactResult> {
    this.ensureOpen();
    const compacted: number[] = [];
    const skipped: number[] = [];
    for (const id of this.router.shardIds()) {
      try {
        await this.writer(id, (db) => db.compact());
        compacted.push(id);
      } catch (e) {
        if (e instanceof LockError) skipped.push(id);
        else throw e;
      }
    }
    return { compacted, skipped };
  }

  stats(): ClusterStats {
    return {
      shardCount: this.router.shardCount,
      writersCached: this.pool.writersCached,
      readersCached: this.pool.readersCached,
      ...this.pool.stats,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.pool.closeAll();
    this.closed = true;
  }
}
