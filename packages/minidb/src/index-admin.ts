// src/index-admin.ts
//
// MiniDb's secondary + compound index administration as a facet: the
// create/drop/list/find API and the definition sidecar loads. The persist
// seams stay on the owner (injected as callbacks — tests stub them on the
// MiniDb instance, same discipline as the text registry's); the definition
// content decisions (live ± staged) live here.

import fs from 'node:fs/promises';
import { fromKStr } from './value-codec.js';
import { REBUILD_YIELD_DOCS } from './generation-builder.js';
import { yieldToLoop } from './text-index/tokenize.js';
import type { Store } from './store.js';
import type { IndexManager, IndexDef, IndexInfo } from './index-manager.js';
import type { CompoundIndexManager, CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
import type { DtIndex } from './dt-index.js';
import type { TextRegistry } from './text-registry.js';
import type { TextIndexBuild } from './text-index/index.js';
import type { RangeOptions } from './skiplist.js';
import type { ValueCodecName } from './types.js';

/** The owner-injected surface the admin facet needs (see the header). */
export interface IndexAdminDeps<V> {
  indexes: IndexManager;
  compound: CompoundIndexManager;
  dt: DtIndex;
  textRegistry: TextRegistry<V>;
  store: () => Store;
  codecName: () => ValueCodecName;
  ensureOpen: () => void;
  ensureWritable: () => void;
  decode: (b: Buffer | undefined) => V | undefined;
  indexable: (v: unknown) => v is Record<string, unknown>;
  /** The owner's stats object (rebuild duration/decode counters). */
  stats: {
    indexRebuildDecoded: number;
    indexRebuildDurationMs: number;
    textRebuildDurationMs: number;
  };
  /** Live records (decoded values), for staged compound rebuilds. */
  liveRecords: () => Generator<{ key: Buffer; value: V | undefined; dt: Record<string, number> | null }>;
  /** Live records with untyped decoded values, for staged secondary rebuilds. */
  liveRecordsRaw: () => Generator<{ key: Buffer; value: unknown }>;
  /** Per-sidecar mutation chains (staged → persist → publish serialization). */
  secondaryDefChain: <T>(fn: () => Promise<T>) => Promise<T>;
  compoundDefChain: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The definition-sidecar write seams (kept on the owner so tests can stub
   *  them on the MiniDb instance); the facet decides WHEN and WHAT to persist. */
  persistIndexDefinitions: (defs: IndexInfo[]) => Promise<void>;
  persistCompoundIndexDefinitions: (defs: CompoundIndexInfo[]) => Promise<void>;
}

export class IndexAdmin<V> {
  constructor(private readonly deps: IndexAdminDeps<V>) {}

  /** One Store walk feeds every staged builder (the open-time full rebuild).
   *  dt comes from record metadata (never decoded); the value is decoded at
   *  most once per record and only when a value-derived index (secondary /
   *  compound / text) actually exists — an index-less open performs a
   *  metadata-only walk. Text indexes whose base build is DEFERRED (the
   *  bounded background build, see MiniDb.deferOpenTextBuilds) are skipped
   *  via `skipTextIndex`: they get neither a staged builder nor feeding. */
  async rebuildAllIndexes(opts: { skipTextIndex?: (name: string) => boolean } = {}): Promise<void> {
    const dtB = this.deps.dt.beginRebuild();
    const secB = this.deps.indexes.indexes.size > 0 ? this.deps.indexes.beginRebuild() : null;
    const cmpB = this.deps.compound.indexes.size > 0 ? this.deps.compound.beginRebuild() : null;
    const textBs: { b: TextIndexBuild }[] = [];
    for (const [name, ti] of this.deps.textRegistry.text) {
      if (opts.skipTextIndex?.(name)) continue;
      textBs.push({ b: ti.beginBuild() });
    }
    const needValues = secB !== null || cmpB !== null || textBs.length > 0;

    const t0 = performance.now();
    let docsSinceYield = 0;
    try {
      for (const rec of this.deps.store().rawRecords()) {
        // Yield periodically so a huge open-time rebuild never hard-blocks the
        // event loop; safe because open() awaits this before publishing the
        // db or starting the background compaction.
        if (++docsSinceYield >= REBUILD_YIELD_DOCS) {
          docsSinceYield = 0;
          await yieldToLoop();
        }
        dtB.add(rec.kstr, rec.dt);
        if (!needValues) continue;
        const value = this.deps.decode(rec.readValue());
        this.deps.stats.indexRebuildDecoded++;
        secB?.add(rec.kstr, value);
        cmpB?.add(rec.kstr, value, rec.dt);
        if (this.deps.indexable(value)) for (const { b } of textBs) b.add(rec.kstr, value);
      }
    } catch (error) {
      for (const { b } of textBs) b.abort();
      throw error;
    }
    this.deps.stats.indexRebuildDurationMs += performance.now() - t0;

    // Commit the fallible builders first (text postings do file I/O); the
    // in-memory swaps cannot fail. A text commit failure leaves every
    // not-yet-committed builder on its previous state.
    const t1 = performance.now();
    try {
      for (const { b } of textBs) await b.commit();
    } catch (error) {
      for (const { b } of textBs) b.abort();
      throw error;
    }
    this.deps.stats.textRebuildDurationMs += performance.now() - t1;
    secB?.commit();
    cmpB?.commit();
    dtB.commit();
  }

  async loadIndexDefinitions(indexPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      for (const d of JSON.parse(raw) as (IndexInfo & IndexDef)[]) this.deps.indexes.create(d.name, d);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async loadCompoundIndexDefinitions(compoundIndexPath: string): Promise<void> {
    try {
      const raw = await fs.readFile(compoundIndexPath, 'utf8');
      for (const d of JSON.parse(raw) as (CompoundIndexInfo & { name: string })[]) {
        this.deps.compound.create(d.name, { groupBy: d.groupBy, orderBy: d.orderBy, orderType: d.orderType });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async createIndex(name: string, opts: IndexDef): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (this.deps.codecName() !== 'json') throw new Error('secondary indexes require valueCodec: "json"');
    // Serialized staged → persist → publish (see secondaryDefChain): the
    // definition is staged off to the side, rebuilt there, persisted as part
    // of the sidecar content, and only then published into the live registry.
    // Any failure discards the staged index — the live registry and the
    // sidecar keep their previous state, so a retry cannot hit a phantom
    // "already exists".
    await this.deps.secondaryDefChain(async () => {
      this.deps.indexes.stage(name, opts);
      try {
        this.deps.indexes.rebuildStaged(name, this.deps.liveRecordsRaw());
        // A unique index must not be created over data that already violates it.
        this.deps.indexes.assertUniqueValid(name);
        await this.deps.persistIndexDefinitions([...this.deps.indexes.list(), this.deps.indexes.stagedInfo(name)]);
      } catch (error) {
        this.deps.indexes.discardStaged(name);
        throw error;
      }
      this.deps.indexes.publish(name);
    });
  }

  async dropIndex(name: string): Promise<boolean> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    return this.deps.secondaryDefChain(async () => {
      // Persist FIRST (content without the definition), remove from the live
      // registry only after the sidecar is durable: a persist failure leaves
      // the index fully usable instead of diverging memory from disk (which a
      // reopen would have resurrected).
      await this.deps.persistIndexDefinitions(this.deps.indexes.list().filter((i) => i.name !== name));
      return this.deps.indexes.drop(name);
    });
  }

  listIndexes(): IndexInfo[] {
    return this.deps.indexes.list();
  }

  findEq(name: string, value: unknown): { key: string; value: V | undefined }[] {
    this.deps.ensureOpen();
    return this.deps.indexes
      .findEq(name, value)
      .map((pk) => ({ key: fromKStr(pk), value: this.deps.decode(this.deps.store().get(pk)) }))
      .filter((r): r is { key: string; value: V } => r.value !== undefined);
  }

  findRange(name: string, opts: Parameters<IndexManager['findRange']>[1]): { key: string; value: V | undefined; field: number }[] {
    this.deps.ensureOpen();
    return this.deps.indexes
      .findRange(name, opts)
      .map(({ pk, value }) => ({ key: fromKStr(pk), value: this.deps.decode(this.deps.store().get(pk)), field: value }))
      .filter((r): r is { key: string; value: V; field: number } => r.value !== undefined);
  }

  async createCompoundIndex(name: string, def: CompoundIndexDef): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (this.deps.codecName() !== 'json') throw new Error('compound indexes require valueCodec: "json"');
    // Serialized staged → persist → publish, the same discipline as
    // createIndex (see compoundDefChain).
    await this.deps.compoundDefChain(async () => {
      this.deps.compound.stage(name, def);
      try {
        this.deps.compound.rebuildStaged(name, this.deps.liveRecords());
        await this.deps.persistCompoundIndexDefinitions([...this.deps.compound.list(), this.deps.compound.stagedInfo(name)]);
      } catch (error) {
        this.deps.compound.discardStaged(name);
        throw error;
      }
      this.deps.compound.publish(name);
    });
  }

  async dropCompoundIndex(name: string): Promise<boolean> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    return this.deps.compoundDefChain(async () => {
      // Persist FIRST (content without the definition), remove from live only
      // after the sidecar is durable (see dropIndex).
      await this.deps.persistCompoundIndexDefinitions(this.deps.compound.list().filter((i) => i.name !== name));
      return this.deps.compound.drop(name);
    });
  }

  listCompoundIndexes(): CompoundIndexInfo[] {
    return this.deps.compound.list();
  }

  /**
   * Ordered range within a group, e.g. "sessions in workspace X ordered by
   * updatedAt". O(log N + limit) — no full sort.
   */
  compoundRange(
    name: string,
    groupValue: unknown,
    opts: RangeOptions<unknown> & { limit?: number } = {},
  ): { key: string; value: V | undefined; orderValue: unknown }[] {
    this.deps.ensureOpen();
    return this.deps.compound
      .range(name, groupValue, opts)
      .map(({ key, orderValue }) => ({
        key: fromKStr(key),
        value: this.deps.decode(this.deps.store().get(key)),
        orderValue,
      }))
      .filter((r): r is { key: string; value: V; orderValue: unknown } => r.value !== undefined);
  }
}
