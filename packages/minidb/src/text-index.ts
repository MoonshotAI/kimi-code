// src/text-index.ts
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
//   - Builds: open and compaction rebuild the whole index from the Store.
//     `build()` is async and yields to the event loop periodically, so a big
//     rebuild never hard-blocks the host process; writes landing mid-build
//     keep applying to the live view (searches stay correct) and are queued
//     for a synchronous replay onto the new base at swap time.
//   - Durability: the postings file is a pure derived cache of the Store; it is
//     rebuilt from the Store on open and on compaction. The Store (snapshot +
//     WAL) is the source of truth, so a crash never loses postings — they are
//     simply rebuilt.

import { getPath } from './query.js';
import { PostingsFile } from './text-postings.js';
import type { PostingEntry } from './text-postings.js';

const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]+/g;
// Postings records store the term length in a uint16. A single document with a
// longer token previously made every postings rebuild throw after the index had
// already been cleared, permanently poisoning the index (and compaction). Such
// tokens can never be real query terms — drop them at tokenization so one
// pathological document cannot destroy the index.
const MAX_TERM_CHARS = 0xffff;

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));
// `build()` yields to the event loop at the first of these two watermarks, so
// many-small-docs and few-huge-docs corpora are both bounded per slice.
const BUILD_YIELD_DOCS = 2048;
const BUILD_YIELD_TOKENS = 500_000;

/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). */
export function tokenize(str: unknown): string[] {
  const s = String(str).toLowerCase();
  const terms: string[] = [];
  const latin = s.match(LATIN);
  // Loop-push instead of `terms.push(...latin)`: spreading a large match array
  // (hundreds of thousands of tokens from a big doc) overflows the call stack.
  // Latin matches are ASCII, so chars == utf8 bytes for the length guard.
  if (latin) for (const t of latin) if (t.length <= MAX_TERM_CHARS) terms.push(t);
  const runs = s.match(CJK) ?? [];
  for (const r of runs) {
    for (let i = 0; i < r.length; i++) {
      terms.push(r[i]!);
      if (i + 1 < r.length) terms.push(r[i]! + r[i + 1]!);
    }
  }
  return terms;
}

function stringLeaves(obj: unknown, acc: string[] = []): string[] {
  if (obj === null || obj === undefined) return acc;
  if (typeof obj === 'string') {
    acc.push(obj);
    return acc;
  }
  if (typeof obj !== 'object') return acc;
  for (const v of Object.values(obj as Record<string, unknown>)) stringLeaves(v, acc);
  return acc;
}

export interface TextIndexOptions {
  fields?: readonly string[] | null;
  /** Custom tokenizer, applied to indexed documents (and to query text when
   *  no `queryTokenizer` is given). Defaults to the built-in word/CJK
   *  `tokenize`. */
  tokenizer?: (text: string) => string[];
  /** Custom tokenizer for query text in `search()`. Defaults to `tokenizer`.
   *  Only diverges for the n-gram index: the query side emits fewer, more
   *  selective terms (a length >= 3 query needs only its 3-grams), while the
   *  index side indexes both widths so every query shape can match. */
  queryTokenizer?: (text: string) => string[];
  /** Path to the postings file. If omitted, the index keeps its base postings
   *  in memory instead of on disk (used by read-only openers, which must not
   *  write to a live writer's directory). */
  postingsPath?: string;
  /** Max number of decoded postings lists to keep in the LRU cache (hot
   *  terms). 0 disables caching. */
  cacheTerms?: number;
}

export interface SearchHit {
  key: string;
  score: number;
}

export interface SearchOptions {
  op?: 'AND' | 'OR';
  limit?: number;
}

const EMPTY_MAP: ReadonlyMap<number, number> = new Map();

/** One write that landed while a `build()` was in flight (see buildQueue). */
type BuildOp =
  | { readonly kind: 'add'; readonly key: string; readonly doc: unknown }
  | { readonly kind: 'remove'; readonly key: string };

export class TextIndex {
  private readonly fields: readonly string[] | null;
  private readonly tokenizer: (text: string) => string[];
  private readonly queryTokenizer: (text: string) => string[];
  private readonly path: string | null;
  private readonly cacheTerms: number;

  // Term dictionary (the in-RAM "postings" map): term -> pointer into the
  // postings file. Public so callers can read the unique-term count via .size.
  readonly postings = new Map<string, PostingEntry>();

  // Per-doc state (residual in-RAM floor: one entry per indexed doc).
  private readonly docLen = new Map<number, number>(); // docID -> token count
  private readonly keys: (string | undefined)[] = []; // docID -> key
  private readonly keyToId = new Map<string, number>(); // key -> docID

  // Write buffer (in-RAM only; folded into queries, dropped on build).
  private readonly delta = new Map<string, Map<number, number>>(); // term -> (docID -> freq)
  private deltaCount = 0;
  private readonly removed = new Set<number>(); // tombstoned docIDs

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
  private memBase: Map<string, Map<number, number>> | null = null;

  // Disk-base mode.
  private pf: PostingsFile | null = null;

  // LRU cache of decoded base postings: term -> [docID, freq][]
  private readonly cache = new Map<string, [number, number][]>();

  /** Number of live indexed documents. */
  N = 0;

  constructor(opts: TextIndexOptions = {}) {
    this.fields = opts.fields ?? null;
    this.tokenizer = opts.tokenizer ?? tokenize;
    this.queryTokenizer = opts.queryTokenizer ?? this.tokenizer;
    this.path = opts.postingsPath ?? null;
    this.cacheTerms = opts.cacheTerms ?? 1024;
    if (!this.path) this.memBase = new Map();
  }

  private extract(doc: unknown): string {
    if (this.fields && this.fields.length) {
      return this.fields
        .map((f) => getPath(doc, f))
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
    }
    return stringLeaves(doc).join(' ');
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
   * Async and event-loop friendly: the tokenization pass yields every
   * BUILD_YIELD_DOCS docs / BUILD_YIELD_TOKENS tokens and the postings write
   * batches its I/O, so a large rebuild never hard-blocks the host process
   * for many seconds the way the old fully-synchronous build did. Mutations
   * arriving mid-build keep applying to the live view (searches stay correct)
   * and are recorded in `buildQueue`; once the new base is swapped in, the
   * queue is replayed synchronously, so the result is exactly as if those ops
   * had arrived after the rebuild.
   *
   * Atomic on failure: everything is staged off to the side first and swapped
   * in only after the new postings file is durably renamed (disk mode), so a
   * failed rebuild (e.g. a transient ENOSPC/EMFILE inside PostingsFile.rebuild)
   * leaves the PREVIOUS index fully functional instead of silently emptying it
   * until the next successful build.
   */
  async build(entries: Iterable<{ key: string; value: unknown }>): Promise<void> {
    if (this.buildQueue !== null) throw new Error('text index build already in progress');
    const queue: BuildOp[] = [];
    this.buildQueue = queue;
    try {
      // Staged state.
      const agg = new Map<string, Map<number, number>>(); // term -> (docID -> freq)
      const newKeys: (string | undefined)[] = []; // docID -> key
      const newKeyToId = new Map<string, number>(); // key -> docID
      const newDocLen = new Map<number, number>(); // docID -> token count
      let n = 0;
      let docsSinceYield = 0;
      let tokensSinceYield = 0;
      for (const { key, value } of entries) {
        const docID = newKeys.length;
        newKeys.push(key);
        newKeyToId.set(key, docID);
        const tokens = this.tokenizer(this.extract(value));
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
        for (const [t, c] of counts) {
          let m = agg.get(t);
          if (!m) agg.set(t, (m = new Map()));
          m.set(docID, c); // docIDs increase monotonically -> insertion order is sorted
        }
        newDocLen.set(docID, tokens.length);
        n++;
        docsSinceYield++;
        tokensSinceYield += tokens.length;
        if (docsSinceYield >= BUILD_YIELD_DOCS || tokensSinceYield >= BUILD_YIELD_TOKENS) {
          docsSinceYield = 0;
          tokensSinceYield = 0;
          await yieldToLoop();
        }
      }

      if (this.path) {
        // Disk mode: write the new postings file (tmp + fsync + atomic rename
        // in PostingsFile.rebuild). The old read handle is closed only at the
        // rename — and only on Windows, where an open fd would block it (POSIX
        // keeps the old inode readable through the rename, so searches never
        // lose the base). A rebuild that throws before its commit leaves the
        // old file/handle untouched; a commit-time failure re-attaches it.
        const oldPf = this.pf;
        let dict: Map<string, PostingEntry>;
        try {
          dict = await PostingsFile.rebuild(this.path, aggToSorted(agg), {
            beforeRename:
              process.platform === 'win32' && oldPf !== null
                ? () => {
                    oldPf.close();
                    if (this.pf === oldPf) this.pf = null;
                  }
                : undefined,
          });
        } catch (e) {
          if (oldPf !== null && !oldPf.open) {
            try {
              this.pf = PostingsFile.open(this.path);
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
        const newPf = PostingsFile.open(this.path);
        this.postings.clear();
        for (const [t, e] of dict) this.postings.set(t, e);
        oldPf?.close();
        this.pf = newPf;
      } else {
        // Memory mode: pure in-memory staging, no fallible I/O involved.
        this.memBase = agg;
      }

      // Swap in the staged per-doc state, drop the write buffer, and replay
      // the ops that landed mid-build onto the new base — one synchronous
      // segment, so no mutation can interleave mid-swap.
      this.docLen.clear();
      for (const [id, len] of newDocLen) this.docLen.set(id, len);
      this.keys.length = 0;
      for (const k of newKeys) this.keys.push(k);
      this.keyToId.clear();
      for (const [k, id] of newKeyToId) this.keyToId.set(k, id);
      this.delta.clear();
      this.deltaCount = 0;
      this.removed.clear();
      this.cache.clear();
      this.N = n;
      this.buildQueue = null;
      for (const op of queue) {
        if (op.kind === 'add') this.add(op.key, op.doc);
        else this.remove(op.key);
      }
    } catch (e) {
      // Staging never touched the live view, so the previous index is intact;
      // the queued ops were already applied to it — just disarm the queue.
      if (this.buildQueue === queue) this.buildQueue = null;
      throw e;
    }
  }

  /** Add or replace a document. Overwrites tombstone the old docID. */
  add(key: string, doc: unknown): void {
    this.buildQueue?.push({ kind: 'add', key, doc });
    // The overwrite's internal remove must NOT queue a second op: replaying
    // the queue applies the add (which itself displaces the old docID), and a
    // queued remove would then delete the freshly-added doc.
    if (this.keyToId.has(key)) this.removeInner(key);
    const docID = this.keys.length;
    this.keys.push(key);
    this.keyToId.set(key, docID);
    const tokens = this.tokenizer(this.extract(doc));
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) {
      let m = this.delta.get(t);
      if (!m) this.delta.set(t, (m = new Map()));
      m.set(docID, c);
      this.deltaCount++;
    }
    this.docLen.set(docID, tokens.length);
    this.N++;
  }

  /** Remove a document by key (tombstone its docID). */
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
    for (const m of this.delta.values()) if (m.delete(id)) this.deltaCount--;
    this.N--;
  }

  /** Decoded base postings for a term (disk, cached; or memory). May still
   *  contain tombstoned docIDs — callers filter via `removed`. */
  private readBase(term: string): ReadonlyMap<number, number> {
    if (this.memBase) return this.memBase.get(term) ?? EMPTY_MAP;

    let arr = this.cache.get(term);
    if (arr) {
      // LRU touch: move to most-recent.
      this.cache.delete(term);
      this.cache.set(term, arr);
    } else {
      const entry = this.postings.get(term);
      arr = entry && this.pf ? this.pf.read(entry) : [];
      if (this.cacheTerms > 0) {
        this.cache.set(term, arr);
        if (this.cache.size > this.cacheTerms) {
          const oldest = this.cache.keys().next().value as string;
          this.cache.delete(oldest);
        }
      }
    }
    const m = new Map<number, number>();
    for (const [id, f] of arr) m.set(id, f);
    return m;
  }

  /** Live postings for a term = (base ∪ delta) minus tombstones. */
  private livePostings(term: string): Map<number, number> {
    const out = new Map<number, number>();
    for (const [id, f] of this.readBase(term)) if (!this.removed.has(id)) out.set(id, f);
    const d = this.delta.get(term);
    if (d) for (const [id, f] of d) if (!this.removed.has(id)) out.set(id, f);
    return out;
  }

  private idf(df: number): number {
    return Math.log(1 + this.N / (df || 1));
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const qtokens = [...new Set(this.queryTokenizer(query))];
    if (!qtokens.length) return [];
    const op = opts.op ?? 'AND';
    const limit = opts.limit ?? 50;

    const termMaps = new Map<string, Map<number, number>>();
    for (const t of qtokens) termMaps.set(t, this.livePostings(t));

    let candidates: Set<number>;
    if (op === 'OR') {
      candidates = new Set();
      for (const m of termMaps.values()) for (const id of m.keys()) candidates.add(id);
    } else {
      const lists = [...termMaps.values()];
      if (lists.some((m) => m.size === 0)) return [];
      lists.sort((a, b) => a.size - b.size);
      candidates = new Set(lists[0]!.keys());
      for (let i = 1; i < lists.length && candidates.size; i++) {
        for (const id of candidates) if (!lists[i]!.has(id)) candidates.delete(id);
      }
    }

    const scored: SearchHit[] = [];
    for (const id of candidates) {
      const len = this.docLen.get(id) ?? 1;
      let score = 0;
      for (const t of qtokens) {
        const f = termMaps.get(t)!.get(id) ?? 0;
        if (f) score += (f / len) * this.idf(termMaps.get(t)!.size);
      }
      if (score > 0) {
        const key = this.keys[id];
        if (key !== undefined) scored.push({ key, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Close the underlying postings file. */
  close(): void {
    if (this.pf) {
      this.pf.close();
      this.pf = null;
    }
  }
}

/** Yield `{ term, entries }` with entries sorted by docID ascending (they are
 *  already in insertion order, which equals ascending docID during build). */
function* aggToSorted(
  agg: Map<string, Map<number, number>>,
): Generator<{ term: string; entries: readonly (readonly [number, number])[] }> {
  for (const [term, m] of agg) {
    const entries = [...m];
    yield { term, entries };
  }
}
