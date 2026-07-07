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
//   - Durability: the postings file is a pure derived cache of the Store; it is
//     rebuilt from the Store on open and on compaction. The Store (snapshot +
//     WAL) is the source of truth, so a crash never loses postings — they are
//     simply rebuilt.

import { getPath } from './query.js';
import { PostingsFile } from './text-postings.js';
import type { PostingEntry } from './text-postings.js';

const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]+/g;

/** Tokenize text into terms (lowercased latin words + CJK uni/bigrams). */
export function tokenize(str: unknown): string[] {
  const s = String(str).toLowerCase();
  const terms: string[] = [];
  const latin = s.match(LATIN);
  // Loop-push instead of `terms.push(...latin)`: spreading a large match array
  // (hundreds of thousands of tokens from a big doc) overflows the call stack.
  if (latin) for (const t of latin) terms.push(t);
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

export class TextIndex {
  private readonly fields: readonly string[] | null;
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

  /**
   * Rebuild the index from scratch over `entries` (the live Store view).
   * Assigns fresh dense docIDs, writes a new postings file (disk mode) or
   * replaces the in-memory base (memory mode), and clears the delta +
   * tombstones. Called on open and on compaction.
   */
  build(entries: Iterable<{ key: string; value: unknown }>): void {
    this.postings.clear();
    this.docLen.clear();
    this.keys.length = 0;
    this.keyToId.clear();
    this.delta.clear();
    this.deltaCount = 0;
    this.removed.clear();
    this.cache.clear();
    this.N = 0;

    const agg = new Map<string, Map<number, number>>(); // term -> (docID -> freq)
    for (const { key, value } of entries) {
      const docID = this.keys.length;
      this.keys.push(key);
      this.keyToId.set(key, docID);
      const tokens = tokenize(this.extract(value));
      const counts = new Map<string, number>();
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [t, c] of counts) {
        let m = agg.get(t);
        if (!m) agg.set(t, (m = new Map()));
        m.set(docID, c); // docIDs increase monotonically -> insertion order is sorted
      }
      this.docLen.set(docID, tokens.length);
      this.N++;
    }

    if (this.path) {
      // Disk mode: rewrite the postings file, then reopen for reads.
      if (this.pf) {
        this.pf.close();
        this.pf = null;
      }
      const dict = PostingsFile.rebuildSync(this.path, aggToSorted(agg));
      for (const [t, e] of dict) this.postings.set(t, e);
      this.pf = PostingsFile.open(this.path);
    } else {
      // Memory mode.
      this.memBase = agg;
    }
  }

  /** Add or replace a document. Overwrites tombstone the old docID. */
  add(key: string, doc: unknown): void {
    if (this.keyToId.has(key)) this.remove(key);
    const docID = this.keys.length;
    this.keys.push(key);
    this.keyToId.set(key, docID);
    const tokens = tokenize(this.extract(doc));
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
    const qtokens = [...new Set(tokenize(query))];
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
