// src/text-index/index.ts
//
// Full-text inverted index, larger-than-RAM.
//
//   - Tokenizer: Latin/number words + CJK unigrams & bigrams (no dictionary,
//     zero dependencies, works for Chinese without a segmenter).
//   - Storage: the bulk (every (doc, term) pair) lives in an on-disk postings
//     file (see text-postings.ts). Only the small term dictionary, per-doc
//     lengths, and key<->docID maps stay in RAM.
//   - Writes: appended to an in-memory `delta`; deletes set a tombstone in
//     `removed`. No disk I/O on the write path.
//   - Reads: `search` reads each query term's postings from disk (or a small
//     LRU cache), merges the in-memory `delta`, drops tombstones, and scores
//     by TF-IDF. Synchronous by design so db.search()/db.query() keep their
//     synchronous API.
//   - Builds: a generation build stages a rebuild whose commit also rebases
//     the live index (the compaction-time postings refresh); a load attaches
//     the generation's persisted dictionary + postings + doc table; the
//     no-generation fallback open path defers the corpus-scale rebuild to a
//     background bounded build pinned at the recovery checkpoint (searches
//     raise TextIndexBuildingError until it commits); indexes the bounded
//     engine cannot take stay on the staged Store rebuild.
//     `build()` is async and yields to the event loop periodically, so a big
//     rebuild never hard-blocks the host process; writes landing mid-build
//     keep applying to the live view (searches stay correct) and are queued
//     for a synchronous replay onto the new base at swap time.
//   - Durability: the postings file is a pure derived cache of the Store;
//     it is checkpointed into each published generation and rebuilt from the
//     Store whenever a generation is absent or invalid. The Store (snapshot +
//     WAL) is the source of truth, so a crash never loses postings — they are
//     simply rebuilt or re-checkpointed.
//
// Module layout: ./tokenize.ts holds the tokenizer pure functions (shared
// with the generation build's worker), ./types.ts the public types + TopK,
// ./builder.ts the staged rebuild aggregator behind build()/beginBuild(),
// ./image.ts the stage-5 image export/attach + postings repointing. This
// file keeps the TextIndex core: live writes, the delta, rebase, and search.

import { PostingsFile } from '../text-postings.js';
import type { PostingEntry } from '../text-postings.js';
import { extractText, MAX_TERM_BYTES, tokenize, yieldToLoop } from './tokenize.js';
import { EMPTY_MAP, TopK } from './types.js';
import type {
  BoundedSearchResult,
  BuildOp,
  SearchHit,
  SearchOptions,
  TextIndexBuild,
  TextIndexOptions,
} from './types.js';
import { feedBuild, StagedBuild } from './builder.js';
import {
  attachImage as attachImageImpl,
  attachImageAsync as attachImageAsyncImpl,
  exportImageState as exportImageStateImpl,
  exportImageStateAsync as exportImageStateAsyncImpl,
  repointPostings as repointPostingsImpl,
} from './image.js';
import type { AttachImageRaw, TextIndexImage } from './image.js';

export * from './tokenize.js';
export * from './types.js';
export type { AttachImageRaw, TextIndexImage } from './image.js';

/**
 * Raised by text searches while the index's base is (re)building. The
 * no-generation fallback open path defers the corpus-scale base build to a
 * background bounded build pinned at the recovery checkpoint; until it
 * commits — or after a build that finally failed (`basePending`) — serving
 * the delta alone would silently return partial results, so searches raise
 * this instead. Callers should surface a "building" state and retry once the
 * build commits.
 */
export class TextIndexBuildingError extends Error {
  readonly code = 'TEXT_INDEX_BUILDING';
  constructor(readonly indexName: string | undefined) {
    super(`text index${indexName ? ` "${indexName}"` : ''} base is still building`);
    this.name = 'TextIndexBuildingError';
  }
}

export class TextIndex {
  private readonly fields: readonly string[] | null;
  private readonly indexName: string | undefined;
  private readonly tokenizer: (text: string) => string[];
  private readonly queryTokenizer: (text: string) => string[];
  /** True when a custom (injected) index tokenizer is in use: its output is
   *  untrusted and gets the per-term length validation in tokensFor. The
   *  built-in tokenizer enforces the limit itself and skips the check. A
   *  built-in NAMED tokenizer injected as functions (the registry's ngram
   *  pair, marked via TextIndexOptions.builtinTokenizer) is not custom. */
  private readonly customTokenizer: boolean;
  private readonly path: string | null;
  private readonly cacheTerms: number;
  private readonly cacheBytesCap: number;

  // Term dictionary (the in-RAM "postings" map): term -> pointer into the
  // postings file. Public so callers can read the unique-term count via .size.
  // The BINDING is swapped wholesale by base commits (an O(1) atomic switch —
  // never mutated entry-by-entry outside of them), so readers must not hold
  // the reference across a build.
  postings = new Map<string, PostingEntry>();

  // Visibility note: the state fields below drop the `private` modifier so
  // image.ts can read/mutate them through its explicit TextIndexImageState
  // view (TS has no package-private). They remain package-internal by
  // convention — do not touch them from outside the text-index module.

  // Per-doc state (residual in-RAM floor: one entry per indexed doc). The
  // bindings are swapped wholesale by base commits (see swapDocStateAndReplay).
  docLen = new Map<number, number>(); // docID -> token count
  keys: (string | undefined)[] = []; // docID -> key
  keyToId = new Map<string, number>(); // key -> docID

  // Write buffer (in-RAM only; folded into queries, dropped on build).
  readonly delta = new Map<string, Map<number, number>>(); // term -> (docID -> freq)
  deltaCount = 0;
  readonly removed = new Set<number>(); // tombstoned docIDs
  // Reverse view of the delta: docID -> its distinct delta terms. remove()
  // walks only the removed doc's own terms through it, instead of scanning
  // every term in the delta vocabulary.
  readonly deltaDocs = new Map<number, Set<string>>();

  /**
   * Ops that landed while a `build()` was in flight. The ops ALSO apply to
   * the live view as usual (searches stay correct during the build); the
   * queue exists so the freshly-staged base can replay them at swap time —
   * the staged iteration may have missed them (already-visited key) or seen
   * them (unvisited key), so replaying the exact op stream onto the new base
   * is what keeps the rebuild precise instead of eventually consistent.
   * Null outside a build.
   */
  private buildQueue: BuildOp[] | null = null;

  // Memory-base mode (no postingsPath): base postings kept in RAM.
  memBase: Map<string, Map<number, number>> | null = null;

  // Disk-base mode.
  pf: PostingsFile | null = null;

  /** Set while the base is known-unavailable because its build was DEFERRED
   *  (from the deferred open-time build's arm until a base commits) or
   *  finally failed: searches raise TextIndexBuildingError rather than
   *  silently serving the delta alone. Cleared by every successful base
   *  commit/attach (swapDocStateAndReplay, attachImage). */
  basePending = false;

  /** Base-swap epoch, bumped by every base commit (swapDocStateAndReplay)
   *  and generation attach (attachImage). Async base reads stamp it and
   *  re-read from the fresh base when a commit lands mid-read, so a
   *  concurrently swapped base can never leak a stale base's postings — a
   *  different docID namespace — into a query or into the decoded-postings
   *  cache. */
  baseEpoch = 0;

  /** Integrity record of the postings file the last successful commitBuild
   *  wrote (bytes + whole-file crc32). Stage 5's generation builder records
   *  it in the manifest for the generation's copy of the file; the loader
   *  restores it on attach, so a CLEAN index's fast path can re-publish the
   *  unchanged file without re-reading it. */
  postingsFileInfo: { bytes: number; crc32: number } | null = null;

  /** The path of the postings file the current base is read from (null for a
   *  memory base). Stage 5's clean-index fast path hard-links THIS file into
   *  the next generation instead of re-tokenizing the corpus. */
  get currentPostingsPath(): string | null {
    return this.pf?.path ?? null;
  }

  // LRU cache of decoded base postings: term -> decoded list + its
  // approximate byte weight; eviction honors BOTH the term cap and the byte
  // budget (cacheBytesCap), so a few hot million-entry lists cannot pin
  // unbounded memory (stage 6).
  private readonly cache = new Map<string, { arr: [number, number][]; bytes: number }>();
  private cacheBytes = 0;

  /** Number of live indexed documents. */
  N = 0;

  constructor(opts: TextIndexOptions = {}) {
    this.fields = opts.fields ?? null;
    this.indexName = opts.name;
    this.tokenizer = opts.tokenizer ?? tokenize;
    this.customTokenizer = opts.tokenizer !== undefined && opts.builtinTokenizer === undefined;
    this.queryTokenizer = opts.queryTokenizer ?? this.tokenizer;
    this.path = opts.postingsPath ?? null;
    this.cacheTerms = opts.cacheTerms ?? 1024;
    this.cacheBytesCap = opts.cacheBytes ?? 64 * 1024 * 1024;
    if (!this.path) this.memBase = new Map();
  }

  /** Approximate byte weight of a cached decoded list (entry pairs plus the
   *  term and array overhead) — the cache's eviction currency. */
  private static cacheEntryBytes(term: string, arr: [number, number][]): number {
    return 64 + Buffer.byteLength(term, 'utf8') + arr.length * 24;
  }

  private cacheGet(term: string): [number, number][] | undefined {
    const hit = this.cache.get(term);
    if (!hit) return undefined;
    // LRU touch: move to most-recent.
    this.cache.delete(term);
    this.cache.set(term, hit);
    return hit.arr;
  }

  private cachePut(term: string, arr: [number, number][]): void {
    if (this.cacheTerms <= 0) return;
    const bytes = TextIndex.cacheEntryBytes(term, arr);
    this.cache.set(term, { arr, bytes });
    this.cacheBytes += bytes;
    while (this.cache.size > this.cacheTerms || (this.cacheBytesCap > 0 && this.cacheBytes > this.cacheBytesCap)) {
      if (this.cache.size === 0) break;
      const oldest = this.cache.keys().next().value as string;
      const ev = this.cache.get(oldest)!;
      this.cache.delete(oldest);
      this.cacheBytes -= ev.bytes;
    }
  }

  // Non-private (see the visibility note above): image.ts's attach clears it.
  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private extract(doc: unknown): string {
    return extractText(this.fields, doc);
  }

  /** Extract + tokenize a document, validating a CUSTOM tokenizer's output at
   *  this boundary: every term must fit the postings record's uint16 utf8
   *  length, or one pathological document would make every later postings
   *  rebuild throw (review #27). Throws BEFORE any state mutates, so a bad
   *  document can never pollute the live view, the delta, or the build queue
   *  (review #24). */
  private tokensFor(doc: unknown): string[] {
    const tokens = this.tokenizer(this.extract(doc));
    if (this.customTokenizer) {
      for (const t of tokens) {
        if (Buffer.byteLength(t, 'utf8') > MAX_TERM_BYTES) {
          throw new RangeError(`text index tokenizer produced a term longer than ${MAX_TERM_BYTES} utf8 bytes`);
        }
      }
    }
    return tokens;
  }

  /** The write path's prepare boundary: tokenize + validate a document for a
   *  later infallible `addPrepared`. A throwing (custom) tokenizer rejects the
   *  write HERE — before the store, delta, or build queue can be touched. */
  prepareAdd(doc: unknown): readonly string[] {
    return this.tokensFor(doc);
  }

  /** Number of distinct terms currently indexed (base + delta). */
  termCount(): number {
    if (this.memBase) {
      // include terms that only exist in delta
      let n = this.memBase.size;
      for (const t of this.delta.keys()) if (!this.memBase.has(t)) n++;
      return n;
    }
    let n = this.postings.size;
    for (const t of this.delta.keys()) if (!this.postings.has(t)) n++;
    return n;
  }

  /** Whether a `build()` is currently in flight. */
  get building(): boolean {
    return this.buildQueue !== null;
  }

  /** Whether this index tokenizes with an injected custom function (such
   *  tokenizers cannot cross the stage-6 worker boundary — the index stays
   *  on the main-thread staged build). Built-in NAMED tokenizers injected
   *  as functions (the ngram pair, see TextIndexOptions.builtinTokenizer)
   *  report false: the worker reconstructs them from the definition name. */
  get hasCustomTokenizer(): boolean {
    return this.customTokenizer;
  }

  /**
   * Whether a postings rebuild would change anything: the write buffer
   * (delta + tombstones) is non-empty. Right after a build both are empty, so
   * a compaction landing immediately after an open-time build does not redo
   * the exact same pass. A build in flight also counts as fresh — its queue
   * replay already folds every concurrent mutation into the new base.
   */
  needsRebuild(): boolean {
    if (this.buildQueue !== null) return false;
    return this.deltaCount > 0 || this.removed.size > 0;
  }

  /**
   * Rebuild the index from scratch over `entries` (the live Store view).
   * Assigns fresh dense docIDs, writes a new postings file (disk mode) or
   * replaces the in-memory base (memory mode), and clears the delta +
   * tombstones. Called on open and on compaction.
   *
   * Async and event-loop friendly: the feeding loop yields every
   * BUILD_YIELD_DOCS docs / BUILD_YIELD_TOKENS tokens and the postings write
   * batches its I/O, so a large rebuild never hard-blocks the host process
   * for many seconds the way the old fully-synchronous build did.
   */
  async build(entries: Iterable<{ key: string; value: unknown }>): Promise<void> {
    await feedBuild(this.beginBuild(), entries);
  }

  /**
   * Stage a rebuild: accumulate docs incrementally, then swap everything in on
   * commit(). Lets the caller feed several indexes from one shared Store walk
   * (one decode per record fanned out to every builder). add() is synchronous
   * (pure tokenization) — a caller feeding many docs should yield to the
   * event loop periodically (see build()); commit() is async (batched
   * postings I/O).
   *
   * Mutations arriving while the build is staged keep applying to the live
   * view (searches stay correct) and are recorded in `buildQueue`; once the
   * new base is swapped in, commit() replays the queue synchronously, so the
   * result is exactly as if those ops had arrived after the rebuild.
   *
   * Atomic on failure: everything is staged off to the side first and swapped
   * in only after the new postings file is durably renamed (disk mode), so a
   * failed commit (e.g. a transient ENOSPC/EMFILE inside PostingsFile.rebuild)
   * leaves the PREVIOUS index fully functional instead of silently emptying
   * it until the next successful build. abort() discards the staged state
   * (nothing is written before commit() runs).
   */
  beginBuild(opts: { postingsPath?: string } = {}): TextIndexBuild {
    if (this.buildQueue !== null) throw new Error('text index build already in progress');
    const queue: BuildOp[] = [];
    this.buildQueue = queue;
    // Failure/abort paths only disarm their own queue: the ops in it were
    // already applied to the live view, which stays authoritative.
    const disarm = (): void => {
      if (this.buildQueue === queue) this.buildQueue = null;
    };
    return new StagedBuild({
      tokensFor: (value) => this.tokensFor(value),
      commit: (staged) =>
        this.commitBuild(queue, staged.agg, staged.keys, staged.keyToId, staged.docLens, staged.n, opts.postingsPath),
      disarm,
    });
  }

  /** Swap a fully staged build into the live index (see beginBuild).
   *  `postingsPathOverride` redirects the new postings file away from
   *  this.path (stage 5: a generation build writes the file INTO the
   *  generation's tmp directory and the live index attaches to it there;
   *  this.path stays the rebuild target for non-generation builds). */
  private async commitBuild(
    queue: BuildOp[],
    agg: Map<string, Map<number, number>>,
    newKeys: (string | undefined)[],
    newKeyToId: Map<string, number>,
    newDocLen: Map<number, number>,
    n: number,
    postingsPathOverride?: string,
  ): Promise<void> {
    const targetPath = postingsPathOverride ?? this.path;
    if (targetPath) {
      // Disk mode: write the new postings file (tmp + fsync + atomic rename
      // in PostingsFile.rebuild). The old read handle is closed only at the
      // rename — and only on Windows, where an open fd would block it (POSIX
      // keeps the old inode readable through the rename, so searches never
      // lose the base). A rebuild that throws before its commit leaves the
      // old file/handle untouched; a commit-time failure re-attaches it.
      const oldPf = this.pf;
      let dict: Map<string, PostingEntry>;
      try {
        const res = await PostingsFile.rebuild(targetPath, aggToSorted(agg), {
          beforeRename:
            process.platform === 'win32' && oldPf !== null
              ? () => {
                  oldPf.close();
                  if (this.pf === oldPf) this.pf = null;
                }
              : undefined,
        });
        dict = res.dict;
        this.postingsFileInfo = { bytes: res.bytes, crc32: res.crc32 };
      } catch (e) {
        if (oldPf !== null && !oldPf.open) {
          try {
            this.pf = PostingsFile.open(targetPath);
          } catch {
            /* old handle unrecoverable; the next successful build fixes it */
          }
        }
        throw e;
      }
      // The rename happened — the old postings are replaced on disk, so from
      // here the swap commits to the new index. A failed reopen (EMFILE & co.)
      // is not special-cased: readBase treats a null pf as an empty base, so
      // reads degrade to delta-only until the next build instead of reading
      // through a stale dictionary.
      const newPf = PostingsFile.open(targetPath);
      this.postings = dict;
      oldPf?.close();
      this.pf = newPf;
    } else {
      // Memory mode: pure in-memory staging, no fallible I/O involved.
      this.memBase = agg;
    }

    this.swapDocStateAndReplay(queue, newKeys, newKeyToId, newDocLen, n);
  }

  /** Drop the write buffer (delta, tombstones, decoded-postings cache) without
   *  touching the base or the doc table. Shared by the base-commit swap (the
   *  fresh base already covers the buffered ops) and by the deferred-build
   *  retry, which re-pins the checkpoint and re-arms the queue from scratch. */
  resetWriteBuffer(): void {
    this.delta.clear();
    this.deltaCount = 0;
    this.deltaDocs.clear();
    this.removed.clear();
    this.clearCache();
  }

  /** Swap in the staged per-doc state, drop the write buffer, and replay
   *  the ops that landed mid-build onto the new base — one synchronous
   *  segment, so no mutation can interleave mid-swap. Shared by commitBuild
   *  (the base was staged by add()) and commitRebase (the base was built by
   *  the stage-6 worker against a pinned checkpoint). The new containers are
   *  ADOPTED by reference (the caller built them for exactly this purpose),
   *  making the switch O(1) + O(queue); the queue carries validated
   *  mutations (key + tokens), so the replay cannot throw. */
  private swapDocStateAndReplay(
    queue: BuildOp[],
    newKeys: (string | undefined)[],
    newKeyToId: Map<string, number>,
    newDocLen: Map<number, number>,
    n: number,
  ): void {
    this.docLen = newDocLen;
    this.keys = newKeys;
    this.keyToId = newKeyToId;
    this.resetWriteBuffer();
    this.basePending = false;
    // Base-swap epoch: async base reads stamp it and re-read from the fresh
    // base when a commit lands mid-read (see readBaseBoundedAsync).
    this.baseEpoch++;
    this.N = n;
    this.buildQueue = null;
    for (const op of queue) {
      if (op.kind === 'add') this.addPrepared(op.key, op.tokens);
      else this.remove(op.key);
    }
  }

  // ---- stage-6 worker rebase ------------------------------------------------
  //
  // The worker build (worker/text-build.ts) produces a fresh base — postings
  // file, term dictionary, and the doc table — OFF the main thread, against a
  // WAL checkpoint the main thread pinned. beginRebase starts capturing the
  // live mutations at that checkpoint (the same buildQueue mechanism
  // beginBuild uses); commitRebase swaps the worker's base in and replays the
  // queue, so the index becomes exactly "the checkpoint base + every op that
  // landed since". abortRebase discards the capture (the live index was never
  // touched by the worker's output).

  /** Start capturing mutations for a worker rebase. Must pair with
   *  commitRebase/abortRebase. */
  beginRebase(): void {
    if (this.buildQueue !== null) throw new Error('text index build already in progress');
    this.buildQueue = [];
  }

  /** Whether a worker rebase is currently capturing. */
  get rebasing(): boolean {
    return this.buildQueue !== null;
  }

  /** The containers a worker rebase needs, prepared OFF the commit path
   *  (design rule 5: the main thread only does short atomic switches). All
   *  O(T)/O(N) construction happens here, in slices with event-loop yields;
   *  the commit then swaps references in O(1) plus the queue replay. */
  static async prepareRebaseContainers(
    dictEntries: Iterable<[string, PostingEntry]>,
    keys: (string | undefined)[],
    docLens: Map<number, number>,
    opts: { sliceEvery?: number } = {},
  ): Promise<{ postings: Map<string, PostingEntry>; keys: (string | undefined)[]; keyToId: Map<string, number>; docLens: Map<number, number> }> {
    const sliceEvery = opts.sliceEvery ?? 65536;
    const postings = new Map<string, PostingEntry>();
    let n = 0;
    for (const [t, e] of dictEntries) {
      postings.set(t, e);
      if (++n % sliceEvery === 0) await yieldToLoop();
    }
    const keyToId = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k !== undefined) keyToId.set(k, i);
      if (i % sliceEvery === sliceEvery - 1) await yieldToLoop();
    }
    return { postings, keys, keyToId, docLens };
  }

  /** Swap in the worker-built base and replay the captured ops. The postings
   *  file was fully written (and crc-recorded) by the worker; the containers
   *  come from prepareRebaseContainers (sliced), so this commit is a short
   *  atomic switch plus the queue replay. On any failure the capture is
   *  disarmed and the PREVIOUS index stays authoritative — the queued ops
   *  were already applied to it, exactly like a failed commitBuild. */
  commitRebase(base: {
    postingsPath: string;
    containers: { postings: Map<string, PostingEntry>; keys: (string | undefined)[]; keyToId: Map<string, number>; docLens: Map<number, number> };
    liveCount: number;
    postingsFileInfo: { bytes: number; crc32: number };
  }): void {
    const queue = this.buildQueue;
    if (queue === null) throw new Error('text index rebase is not in progress');
    const disarm = (): void => {
      if (this.buildQueue === queue) this.buildQueue = null;
    };
    let newPf: PostingsFile;
    try {
      newPf = PostingsFile.open(base.postingsPath);
    } catch (e) {
      disarm();
      throw e;
    }
    // A memory-base index (read-only opens, which must not write into a live
    // writer's db dir) ADOPTS the worker's disk base here — the file lives at
    // a caller-owned location outside the db dir, the same memBase→disk flip
    // attachImage makes on a generation load.
    this.memBase = null;
    const oldPf = this.pf;
    this.postings = base.containers.postings;
    oldPf?.close();
    this.pf = newPf;
    this.postingsFileInfo = { ...base.postingsFileInfo };

    this.swapDocStateAndReplay(queue, base.containers.keys, base.containers.keyToId, base.containers.docLens, base.liveCount);
  }

  /** Discard the rebase capture without swapping (worker failed/cancelled):
   *  the live index keeps its previous base, untouched by the worker. */
  abortRebase(): void {
    this.buildQueue = null;
  }

  /** Add or replace a document. Tokenizes (and validates a custom tokenizer's
   *  output) BEFORE any state changes, so a throwing tokenizer leaves the
   *  live view, the delta, and the build queue untouched (review #24); an
   *  overwrite's old document stays searchable. */
  add(key: string, doc: unknown): void {
    this.addPrepared(key, this.tokensFor(doc));
  }

  /** Apply an already-tokenized, already-validated document write (see
   *  prepareAdd). Overwrites tombstone the old docID. Must not throw: pure
   *  map/set bookkeeping — this is the only text-index entry point the db's
   *  purified applyOp uses. */
  addPrepared(key: string, tokens: readonly string[]): void {
    this.buildQueue?.push({ kind: 'add', key, tokens });
    // The overwrite's internal remove must NOT queue a second op: replaying
    // the queue applies the add (which itself displaces the old docID), and a
    // queued remove would then delete the freshly-added doc.
    if (this.keyToId.has(key)) this.removeInner(key);
    const docID = this.keys.length;
    this.keys.push(key);
    this.keyToId.set(key, docID);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) {
      let m = this.delta.get(t);
      if (!m) this.delta.set(t, (m = new Map()));
      m.set(docID, c);
      this.deltaCount++;
    }
    this.deltaDocs.set(docID, new Set(counts.keys()));
    this.docLen.set(docID, tokens.length);
    this.N++;
  }

  /** Remove a document by key (tombstone its docID). Walks only the doc's own
   *  delta terms via the reverse map — O(terms in document), not O(all delta
   *  terms). */
  remove(key: string): void {
    this.buildQueue?.push({ kind: 'remove', key });
    this.removeInner(key);
  }

  private removeInner(key: string): void {
    const id = this.keyToId.get(key);
    if (id === undefined) return;
    this.removed.add(id);
    this.keyToId.delete(key);
    this.keys[id] = undefined;
    this.docLen.delete(id);
    const terms = this.deltaDocs.get(id);
    if (terms) {
      for (const t of terms) {
        const m = this.delta.get(t);
        if (m?.delete(id)) this.deltaCount--;
        if (m && m.size === 0) this.delta.delete(t);
      }
      this.deltaDocs.delete(id);
    }
    this.N--;
  }

  /**
   * Decoded base postings for a term (disk, cached; or memory), budgeted:
   * with `maxEntries`, a list longer than the budget is capped to its leading
   * (lowest-docID) prefix and flagged `capped`. A capped read never populates
   * the LRU cache, so a later uncapped query still decodes the full list.
   * May still contain tombstoned docIDs — callers filter via `removed`.
   */
  private readBaseBounded(
    term: string,
    maxEntries: number | undefined,
  ): { map: ReadonlyMap<number, number>; capped: boolean } {
    if (this.memBase) {
      const m = this.memBase.get(term);
      if (m === undefined || maxEntries === undefined || m.size <= maxEntries) {
        return { map: m ?? EMPTY_MAP, capped: false };
      }
      const out = new Map<number, number>();
      let i = 0;
      for (const [id, f] of m) {
        if (i++ >= maxEntries) break;
        out.set(id, f);
      }
      return { map: out, capped: true };
    }

    const entry = this.postings.get(term);
    if (entry !== undefined && maxEntries !== undefined && entry.df > maxEntries) {
      // Over budget before decoding even starts: cap the decode itself and
      // skip the cache (a partial list must never be cached as complete).
      const arr = this.pf ? this.pf.read(entry, maxEntries) : [];
      const m = new Map<number, number>();
      for (const [id, f] of arr) m.set(id, f);
      return { map: m, capped: true };
    }

    let arr = this.cacheGet(term);
    if (!arr) {
      arr = entry && this.pf ? this.pf.read(entry) : [];
      this.cachePut(term, arr);
    }
    const m = new Map<number, number>();
    for (const [id, f] of arr) m.set(id, f);
    return { map: m, capped: false };
  }

  /** Async twin of readBaseBounded (stage 6): identical cache semantics and
   *  results; only the postings file read moves off the event loop.
   *
   *  A base commit can land between the dictionary read and the postings
   *  read (the generation build's staged commit swaps pf+dict+doc-table as
   *  one synchronous segment, exactly where this method awaits): the result
   *  would mix two bases' docID namespaces, and worse, the stale list would
   *  be cached AFTER the commit's cache clear — poisoning later queries
   *  deterministically. Re-read from the fresh base when the swap epoch
   *  moved, and only cache a list provably read under a still-current
   *  epoch. */
  private async readBaseBoundedAsync(
    term: string,
    maxEntries: number | undefined,
  ): Promise<{ map: ReadonlyMap<number, number>; capped: boolean }> {
    if (this.memBase) return this.readBaseBounded(term, maxEntries);

    for (let attempt = 0; ; attempt++) {
      const epoch = this.baseEpoch;
      const entry = this.postings.get(term);
      let result: { map: ReadonlyMap<number, number>; capped: boolean };
      let cacheable: [number, number][] | null = null;
      try {
        if (entry !== undefined && maxEntries !== undefined && entry.df > maxEntries) {
          // Over budget before decoding even starts: cap the decode itself
          // and skip the cache (a partial list is never cached as complete).
          const arr = this.pf ? await this.pf.readAsync(entry, maxEntries) : [];
          const m = new Map<number, number>();
          for (const [id, f] of arr) m.set(id, f);
          result = { map: m, capped: true };
        } else {
          let arr = this.cacheGet(term);
          if (!arr) {
            arr = entry && this.pf ? await this.pf.readAsync(entry) : [];
            cacheable = arr;
          }
          const m = new Map<number, number>();
          for (const [id, f] of arr) m.set(id, f);
          result = { map: m, capped: false };
        }
      } catch (e) {
        // A base commit landing mid-read also CLOSES the previous handle
        // under us ('postings file is closed') — same straddle, same retry.
        if (this.baseEpoch !== epoch && attempt < 2) continue;
        throw e;
      }
      if (this.baseEpoch === epoch) {
        if (cacheable !== null) this.cachePut(term, cacheable);
        return result;
      }
      // The base moved mid-read: retry against the fresh one (bounded — a
      // churning base sequence falls back to the last, uncached read).
      if (attempt >= 2) return result;
    }
  }

  /**
   * Live postings for a term = (base ∪ delta) minus tombstones, budgeted: at
   * most `maxEntries` entries are visited (base first, then delta); `capped`
   * flags a shortfall and `visited` reports the decoded/merged entry count
   * feeding the query-level budget accounting.
   */
  private livePostingsBounded(
    term: string,
    maxEntries: number | undefined,
  ): { map: Map<number, number>; capped: boolean; visited: number } {
    const out = new Map<number, number>();
    let capped = false;
    const base = this.readBaseBounded(term, maxEntries);
    if (base.capped) capped = true;
    for (const [id, f] of base.map) if (!this.removed.has(id)) out.set(id, f);
    let visited = base.map.size;
    const d = this.delta.get(term);
    if (d) {
      for (const [id, f] of d) {
        if (maxEntries !== undefined && visited >= maxEntries) {
          capped = true;
          break;
        }
        visited++;
        if (!this.removed.has(id)) out.set(id, f);
      }
    }
    return { map: out, capped, visited };
  }

  /** Async twin of livePostingsBounded (stage 6): only the base read moves
   *  off the event loop; delta merge and budget accounting are identical. */
  private async livePostingsBoundedAsync(
    term: string,
    maxEntries: number | undefined,
  ): Promise<{ map: Map<number, number>; capped: boolean; visited: number }> {
    const out = new Map<number, number>();
    let capped = false;
    const base = await this.readBaseBoundedAsync(term, maxEntries);
    if (base.capped) capped = true;
    for (const [id, f] of base.map) if (!this.removed.has(id)) out.set(id, f);
    let visited = base.map.size;
    const d = this.delta.get(term);
    if (d) {
      for (const [id, f] of d) {
        if (maxEntries !== undefined && visited >= maxEntries) {
          capped = true;
          break;
        }
        visited++;
        if (!this.removed.has(id)) out.set(id, f);
      }
    }
    return { map: out, capped, visited };
  }

  /** Estimated document frequency without decoding the list: the on-disk
   *  dictionary carries df, the memory base and delta know their size. */
  private estimatedDf(term: string): number {
    let n = this.memBase ? (this.memBase.get(term)?.size ?? 0) : (this.postings.get(term)?.df ?? 0);
    n += this.delta.get(term)?.size ?? 0;
    return n;
  }

  private idf(df: number): number {
    return Math.log(1 + this.N / (df || 1));
  }

  /** Candidate intersection + TF-IDF scoring over already-decoded term maps —
   *  the shared in-memory tail of searchBounded/searchBoundedAsync. */
  private scoreTermMaps(
    qtokens: string[],
    termMaps: Map<string, Map<number, number>>,
    op: 'AND' | 'OR',
    limit: number,
    visits: number,
    truncated: boolean,
  ): BoundedSearchResult {
    let candidates: Set<number>;
    if (op === 'OR') {
      candidates = new Set();
      for (const m of termMaps.values()) for (const id of m.keys()) candidates.add(id);
    } else {
      const lists = [...termMaps.values()];
      if (lists.some((m) => m.size === 0)) return { hits: [], visits, truncated };
      lists.sort((a, b) => a.size - b.size);
      candidates = new Set(lists[0]!.keys());
      for (let i = 1; i < lists.length && candidates.size; i++) {
        for (const id of candidates) if (!lists[i]!.has(id)) candidates.delete(id);
      }
    }

    const top = new TopK(limit);
    for (const id of candidates) {
      const len = this.docLen.get(id) ?? 1;
      let score = 0;
      for (const t of qtokens) {
        const f = termMaps.get(t)!.get(id) ?? 0;
        if (f) score += (f / len) * this.idf(termMaps.get(t)!.size);
      }
      if (score > 0) {
        const key = this.keys[id];
        if (key !== undefined) top.offer({ key, score });
      }
    }
    return { hits: top.sorted(), visits, truncated };
  }

  /** Query tokenization + selective-first term ordering (shared by the sync
   *  and async search paths). */
  private queryTerms(query: string): string[] {
    return [...new Set(this.queryTokenizer(query))];
  }

  /** Raise TextIndexBuildingError while the base is known-unavailable: a
   *  deferred open-time build has not committed yet (basePending is set at
   *  arm time) or finally failed. Serving the delta alone would silently
   *  return partial results. A staged/worker build with a LIVE old base
   *  underneath (generation builds, createTextIndex) keeps serving normally
   *  — only a build that started from a baseless index sets basePending. */
  private ensureBaseAvailable(): void {
    if (this.basePending) throw new TextIndexBuildingError(this.indexName);
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    return this.searchBounded(query, opts).hits;
  }

  searchBounded(query: string, opts: SearchOptions = {}): BoundedSearchResult {
    this.ensureBaseAvailable();
    const qtokens = this.queryTerms(query);
    if (!qtokens.length) return { hits: [], visits: 0, truncated: false };
    const op = opts.op ?? 'AND';
    const limit = opts.limit ?? 50;

    // Decode the most selective terms first: under a visit budget the hot
    // terms are the ones that get prefix-capped, and AND-intersection starts
    // from the smallest candidate set either way. Order never changes the
    // unbudgeted result.
    const terms = qtokens
      .map((t) => ({ t, df: this.estimatedDf(t) }))
      .sort((a, b) => a.df - b.df);

    let remaining = opts.maxVisits ?? Number.POSITIVE_INFINITY;
    let visits = 0;
    let truncated = false;
    const termMaps = new Map<string, Map<number, number>>();
    for (const { t } of terms) {
      const cap = remaining === Number.POSITIVE_INFINITY ? undefined : Math.max(0, remaining);
      const live = this.livePostingsBounded(t, cap);
      termMaps.set(t, live.map);
      visits += live.visited;
      remaining -= live.visited;
      if (live.capped) truncated = true;
    }

    return this.scoreTermMaps(qtokens, termMaps, op, limit, visits, truncated);
  }

  /** Async twin of searchBounded (stage 6): identical results and budget
   *  semantics; only the postings reads move off the event loop, so a cold
   *  disk-mode query no longer stalls every other request on readSync. */
  async searchBoundedAsync(query: string, opts: SearchOptions = {}): Promise<BoundedSearchResult> {
    this.ensureBaseAvailable();
    const qtokens = this.queryTerms(query);
    if (!qtokens.length) return { hits: [], visits: 0, truncated: false };
    const op = opts.op ?? 'AND';
    const limit = opts.limit ?? 50;

    const terms = qtokens
      .map((t) => ({ t, df: this.estimatedDf(t) }))
      .sort((a, b) => a.df - b.df);

    let remaining = opts.maxVisits ?? Number.POSITIVE_INFINITY;
    let visits = 0;
    let truncated = false;
    const termMaps = new Map<string, Map<number, number>>();
    for (const { t } of terms) {
      const cap = remaining === Number.POSITIVE_INFINITY ? undefined : Math.max(0, remaining);
      const live = await this.livePostingsBoundedAsync(t, cap);
      termMaps.set(t, live.map);
      visits += live.visited;
      remaining -= live.visited;
      if (live.capped) truncated = true;
    }

    return this.scoreTermMaps(qtokens, termMaps, op, limit, visits, truncated);
  }

  /** Async convenience: the async counterpart of search(). */
  async searchAsync(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return (await this.searchBoundedAsync(query, opts)).hits;
  }

  /** Stage-5 generation build: a synchronous deep-enough snapshot of the live
   *  state for image serialization. The maps/arrays are copied so later
   *  mutations of the live index never reach the serialized image. Must run
   *  while no build is in flight (a committed build's state is what a
   *  generation serializes). */
  exportImageState(): TextIndexImage {
    return exportImageStateImpl(this);
  }

  /** Sliced variant of exportImageState (stage 6): identical content, copied
   *  in slices with event-loop yields so a large index's image copy never
   *  stalls the loop for the whole pass. Consistency across slices is
   *  preserved by ORDER: the doc table (keys) is copied LAST — a write that
   *  lands mid-copy appends its docID to keys BEFORE touching delta/docLens
   *  (see addPrepared), so every docID referenced by the earlier-copied
   *  delta/removed exists in the keys array (a superset is fine; holes are
   *  impossible before the copy point). The generation load's WAL-delta
   *  replay reconciles any mid-copy write exactly as it reconciles any
   *  post-seal write. */
  async exportImageStateAsync(opts: { sliceEvery?: number } = {}): Promise<TextIndexImage> {
    return exportImageStateAsyncImpl(this, opts);
  }

  /** Stage-5 generation load: attach a persisted base + write-buffer state,
   *  making the index exactly equal to the one the generation sealed —
   *  dictionary, doc table, tombstones and delta included. Any previous state
   *  is replaced; a memory-base instance switches to disk-base on the
   *  generation's postings file (read-only opens attach the same way — the
   *  file is only ever read). */
  attachImage(args: { postingsPath: string } & TextIndexImage): void {
    attachImageImpl(this, args);
  }

  /** Sliced variant of attachImage (the open-time main-thread path):
   *  identical resulting state, but every O(terms/docs) map construction is
   *  built from the raw parsed images in slices with event-loop yields, so
   *  attaching a large generation's base never stalls the loop for the whole
   *  pass. */
  async attachImageAsync(args: AttachImageRaw, opts: { sliceEvery?: number } = {}): Promise<void> {
    await attachImageAsyncImpl(this, args, opts);
  }

  /** Stage-5 generation build: after the atomic publish rename, repoint the
   *  live base handle from the build's tmp directory to the published
   *  generation directory (same file, final name). On Windows an open handle
   *  would have blocked the directory rename, so the caller closes before the
   *  rename and reopens here; POSIX just updates the path (the fd stays valid
   *  across the rename). A reopen failure degrades reads to delta-only until
   *  the next build, exactly like commitBuild's reopen failure. */
  repointPostings(newPath: string): void {
    repointPostingsImpl(this, newPath);
  }

  /** Close the underlying postings file. */
  close(): void {
    if (this.pf) {
      this.pf.close();
      this.pf = null;
    }
  }
}

/** Yield `{ term, entries }` with entries sorted by docID ascending: the agg
 *  maps' insertion order already IS ascending docID (docIDs increase
 *  monotonically during a build), so the Map itself is yielded — never a
 *  per-term spread, which was an OOM vector on million-entry lists. */
function* aggToSorted(
  agg: Map<string, Map<number, number>>,
): Generator<{ term: string; entries: ReadonlyMap<number, number> }> {
  for (const [term, m] of agg) {
    yield { term, entries: m };
  }
}
