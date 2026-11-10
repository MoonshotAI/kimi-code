// src/text-registry.ts
//
// MiniDb's text-index registry as a facet: the live TextIndex map, the
// persisted definition list, and the staged-drop marks, plus the whole
// registry lifecycle (definition load/persist, create/drop, the legacy
// postings rebuild, and the search entry points). Everything it needs from
// MiniDb (dir/codec/lifecycle gates, the store, value decode + async read,
// the live-record feed) is injected through TextRegistryDeps, so this module
// never imports the MiniDb class itself. The generation/compaction paths
// (still in index.ts) read and iterate the state through MiniDb's private
// views, which forward to this registry.

import fs from 'node:fs/promises';
import path from 'node:path';
import { TEXT_INDEXES_FILE, rootPostingsFile } from './generation.js';
import { TextIndex } from './text-index/index.js';
import type { TextIndexOptions } from './text-index/index.js';
import { createNgramTokenizer } from './trigram.js';
import type { TextIndexTokenizerName } from './trigram.js';
import { createSerializer } from './serialize.js';
import { fromKStr } from './value-codec.js';
import type { Store } from './store.js';
import type { ValueCodecName } from './types.js';
import type { TextBuildCheckpoint } from './worker/text-build.js';

/** Persisted shape of one entry in `db.textindexes.json`. `tokenizer` is
 *  absent in definitions written before n-gram support existed, which means
 *  'default'; it is also omitted for new default indexes so their definitions
 *  keep the legacy shape byte-for-byte. */
export interface TextIndexDef {
  name: string;
  fields: readonly string[] | null;
  tokenizer?: TextIndexTokenizerName;
}

/** Map a persisted tokenizer name to the TextIndex tokenizer pair. 'default'
 *  (or a legacy definition without the field) returns empty options, keeping
 *  the built-in tokenizer path untouched. The query side only diverges for
 *  'ngram' (a length >= 3 query emits only its 3-grams); both sides share the
 *  same normalization, so candidates stay a superset of the true matches. The
 *  ngram pair travels as functions but is marked `builtinTokenizer`, so the
 *  index does NOT count as custom-tokenized (stage-6 worker eligibility). */
export function textIndexTokenizers(
  name: TextIndexTokenizerName | undefined,
): Pick<TextIndexOptions, 'tokenizer' | 'queryTokenizer' | 'builtinTokenizer'> {
  if (name === undefined || name === 'default') return {};
  if (name === 'ngram') {
    return {
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
      builtinTokenizer: 'ngram',
    };
  }
  throw new RangeError(`unknown text index tokenizer: ${String(name)}`);
}

/** The owner-injected surface the registry needs (see the header). */
export interface TextRegistryDeps<V> {
  dir: () => string;
  readOnly: () => boolean;
  codecName: () => ValueCodecName;
  store: () => Store;
  ensureOpen: () => void;
  ensureWritable: () => void;
  decode: (b: Buffer | undefined) => V | undefined;
  readValueAsync: (kstr: string) => Promise<Buffer | undefined>;
  /** Live indexable records with canonical keys, for (re)building text indexes. */
  textRecords: () => Generator<{ key: string; value: unknown }>;
  /** The definition-sidecar write seam (kept on the owner so tests can stub
   *  it on the MiniDb instance); the registry decides WHEN and WHAT to
   *  persist, the owner performs the atomic write. */
  persistTextIndexDefinitions: (defs: TextIndexDef[]) => Promise<void>;
  /** The owner's bounded full-corpus build (worker/inline + rebase — see
   *  MiniDb.boundedTextBuild). Returns null when the index is ineligible and
   *  the caller must use the staged `ti.build(...)` instead. */
  boundedTextBuild: (name: string, ti: TextIndex, def: TextIndexDef, checkpoint: TextBuildCheckpoint | null) => Promise<'worker' | 'inline' | null>;
}

export class TextRegistry<V> {
  // Non-private (package-internal by convention): MiniDb's generation /
  // compaction / write paths read and iterate these through private views.
  readonly text = new Map<string, TextIndex>();
  textDefs: TextIndexDef[] = [];
  /** Names staged for drop by dropTextIndex (plan 10's "mark staged-drop,
   *  persist, then remove from live"). A compaction's postings rebuild
   *  (rebuildTextPostings) skips them: without the mark, a build starting in
   *  the drop's persist window could commit AFTER the drop's close+rm —
   *  re-creating the postings file as an orphan and leaking the reopened
   *  handle. */
  readonly textDrops = new Set<string>();

  private readonly textDefChain = createSerializer();

  constructor(private readonly deps: TextRegistryDeps<V>) {}

  private textIndexPath(): string {
    return path.join(this.deps.dir(), TEXT_INDEXES_FILE);
  }

  /** On-disk postings file path for a text index (root location — the legacy
   *  pre-generation home; the name sanitization lives in generation.ts). */
  textPostingsPath(name: string): string {
    return path.join(this.deps.dir(), rootPostingsFile(name));
  }

  /** The canonical definition shape a text index's manifest hash is computed
   *  from (both sides use it, so a legacy definition without `tokenizer`
   *  hashes identically to an explicit 'default'). */
  static canonicalTextDef(d: TextIndexDef): { name: string; fields: readonly string[] | null; tokenizer: string } {
    return { name: d.name, fields: d.fields, tokenizer: d.tokenizer ?? 'default' };
  }

  /** LEGACY postings maintenance (indexGenerations: false): rebuild every
   *  dirty text index's on-disk postings from the live Store. With
   *  generations enabled this whole job is superseded by the generation
   *  build (the staged text builds + clean re-publish), so it only runs on
   *  the legacy onCompacted path. Drops the in-memory delta + tombstones and
   *  reclaims orphaned postings records — postings are pure derived state,
   *  so this is only for space/latency, never for correctness. Indexes with
   *  an empty write buffer are skipped: a fresh base must not be redone. */
  async rebuildTextPostings(): Promise<void> {
    for (const [name, ti] of this.text) {
      // Skip indexes staged for drop (see textDrops): their postings are
      // about to be removed, and a build committing after the drop's
      // close+rm would re-create the file as an orphan and leak the reopened
      // handle. The mark check and ti.build()'s synchronous beginBuild() are
      // one tick apart at most — see dropTextIndex for why that is safe.
      if (this.textDrops.has(name)) continue;
      if (ti.needsRebuild()) await ti.build(this.deps.textRecords());
    }
  }

  async loadTextIndexDefinitions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.textIndexPath(), 'utf8');
      this.textDefs = JSON.parse(raw) as TextIndexDef[];
      for (const d of this.textDefs) {
        this.text.set(
          d.name,
          new TextIndex({
            name: d.name,
            fields: d.fields,
            ...textIndexTokenizers(d.tokenizer),
            // A read-only opener must not write to a live writer's postings file;
            // it keeps the base postings in memory instead.
            postingsPath: this.deps.readOnly() ? undefined : this.textPostingsPath(d.name),
          }),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }


  async createTextIndex(
    name: string,
    { fields, tokenizer }: { fields?: readonly string[]; tokenizer?: TextIndexTokenizerName } = {},
  ): Promise<void> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    if (this.deps.codecName() !== 'json') throw new Error('text indexes require valueCodec: "json"');
    await this.textDefChain(async () => {
      if (this.text.has(name)) throw new Error(`text index "${name}" already exists`);
      const ti = new TextIndex({ name, fields, ...textIndexTokenizers(tokenizer), postingsPath: this.textPostingsPath(name) });
      // The staged definition: joins the persisted set (publish) only after
      // the sidecar is durable.
      const def: TextIndexDef = { name, fields: fields ?? null, tokenizer };
      // Register BEFORE building: the build yields to the event loop, and
      // registering makes concurrent writes feed the index's build queue, which
      // the build replays onto the new base — so the finished index reflects
      // every write whenever it landed. Until the build completes, searches on
      // the index see only its post-registration delta. Any failure below
      // discards the staged index, so a retry cannot hit a phantom
      // "already exists".
      this.text.set(name, ti);
      try {
        // Large existing corpora go through the memory-bounded build (worker
        // thread / inline core + rebase): the staged ti.build aggregates the
        // whole term->postings map in RAM and OOMs at scale. A bounded-build
        // FAILURE propagates (the staged fallback would repeat the OOM);
        // ineligibility (hosted === null) uses the staged path directly.
        const hosted = await this.deps.boundedTextBuild(name, ti, def, null);
        if (hosted === null) await ti.build(this.deps.textRecords());
        await this.deps.persistTextIndexDefinitions([...this.textDefs, def]);
      } catch (error) {
        // Discard the staged index so the in-memory state and the definition
        // sidecar (which does not name this index) do not diverge; drop the
        // derived postings file with it, exactly like dropTextIndex would.
        this.text.delete(name);
        ti.close();
        await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
        throw error;
      }
      this.textDefs.push(def);
    });
  }

  async dropTextIndex(name: string): Promise<boolean> {
    this.deps.ensureOpen();
    this.deps.ensureWritable();
    return this.textDefChain(async () => {
      const ti = this.text.get(name);
      // Dropping mid-build would orphan the in-flight postings write (the file
      // is removed while the build is still producing it). The build can only
      // be a compaction's postings rebuild — createTextIndex builds under this
      // same chain.
      if (ti?.building) throw new Error(`text index "${name}" is still building`);
      // Mark staged-drop BEFORE the persist window: a compaction's postings
      // rebuild checks the mark and skips this index (see textDrops), so no
      // build can start while the persist below is in flight. The marking is
      // synchronous with the building check above, so a build is either
      // already running (caught there) or can never start (blocked here).
      this.textDrops.add(name);
      try {
        // Persist FIRST (content without the definition), remove from live and
        // release the resources only after the sidecar is durable: a persist
        // failure leaves the index fully usable (see dropIndex).
        const nextDefs = this.textDefs.filter((d) => d.name !== name);
        await this.deps.persistTextIndexDefinitions(nextDefs);
        const ok = this.text.delete(name);
        if (ti) {
          ti.close();
          await fs.rm(this.textPostingsPath(name), { force: true }).catch(() => {});
        }
        this.textDefs = nextDefs;
        return ok;
      } finally {
        this.textDrops.delete(name);
      }
    });
  }

  search(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): { key: string; value: V | undefined; score: number }[] {
    return this.searchBounded(name, q, opts).hits;
  }

  /**
   * `search` with work accounting: `opts.maxVisits` bounds how many posting
   * entries the index visits (see TextIndex.searchBounded); the result
   * reports the visits and whether the budget truncated the candidate set
   * (hits are then a subset of the full matches, never false hits).
   */
  searchBounded(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): { hits: { key: string; value: V; score: number }[]; visits: number; truncated: boolean } {
    this.deps.ensureOpen();
    const ti = this.text.get(name);
    if (!ti) throw new Error(`no such text index: ${name}`);
    const res = ti.searchBounded(q, opts);
    const hits = res.hits
      .map(({ key, score }) => ({ key: fromKStr(key), value: this.deps.decode(this.deps.store().get(key)), score }))
      .filter((r): r is { key: string; value: V; score: number } => r.value !== undefined);
    return { hits, visits: res.visits, truncated: res.truncated };
  }

  /** Async twin of searchBounded (stage 6, additive): identical hits and
   *  budget accounting; the postings reads and the disk-mode value reads run
   *  off the event loop. The server's search path prefers this variant. */
  async searchBoundedAsync(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): Promise<{ hits: { key: string; value: V; score: number }[]; visits: number; truncated: boolean }> {
    this.deps.ensureOpen();
    const ti = this.text.get(name);
    if (!ti) throw new Error(`no such text index: ${name}`);
    const res = await ti.searchBoundedAsync(q, opts);
    const hits: { key: string; value: V; score: number }[] = [];
    for (const { key, score } of res.hits) {
      const buf = await this.deps.readValueAsync(key);
      if (buf === undefined) continue;
      hits.push({ key: fromKStr(key), value: this.deps.decode(buf)!, score });
    }
    return { hits, visits: res.visits, truncated: res.truncated };
  }

  /** Async convenience: the async counterpart of search(). */
  async searchAsync(
    name: string,
    q: string,
    opts: { op?: 'AND' | 'OR'; limit?: number; maxVisits?: number } = {},
  ): Promise<{ key: string; value: V | undefined; score: number }[]> {
    return (await this.searchBoundedAsync(name, q, opts)).hits;
  }
}
