// src/text-index/types.ts
//
// Public types of the full-text index (options, search results, the staged
// build contract) plus the small shared pieces both the core index and the
// builder rely on (TopK / EMPTY_MAP / BuildOp).

import type { TextIndexTokenizerName } from '../trigram.js';

export interface TextIndexOptions {
  fields?: readonly string[] | null;
  /** Optional index name, carried into TextIndexBuildingError for diagnostics. */
  name?: string;
  /** Custom tokenizer, applied to indexed documents (and to query text when
   *  no `queryTokenizer` is given). Defaults to the built-in word/CJK
   *  `tokenize`. */
  tokenizer?: (text: string) => string[];
  /** Custom tokenizer for query text in `search()`. Defaults to `tokenizer`.
   *  Only diverges for the n-gram index: the query side emits fewer, more
   *  selective terms (a length >= 3 query needs only its 3-grams), while the
   *  index side indexes both widths so every query shape can match. */
  queryTokenizer?: (text: string) => string[];
  /** Set when `tokenizer`/`queryTokenizer` are the FUNCTIONS OF A BUILT-IN
   *  named tokenizer (the registry injects the ngram pair as functions).
   *  Such an index is NOT "custom": its tokenizer can be reconstructed from
   *  the persisted definition name on the other side of the stage-6 worker
   *  boundary, so it stays eligible for the workerized generation build. */
  builtinTokenizer?: TextIndexTokenizerName;
  /** Path to the postings file. If omitted, the index keeps its base postings
   *  in memory instead of on disk (used by read-only openers, which must not
   *  write to a live writer's directory). */
  postingsPath?: string;
  /** Max number of decoded postings lists to keep in the LRU cache (hot
   *  terms). 0 disables caching. */
  cacheTerms?: number;
  /** Max approximate BYTES of decoded postings kept in the LRU cache (stage
   *  6): the term-count cap alone let a few million-entry lists pin
   *  unbounded memory. Eviction stops when both caps are satisfied.
   *  Defaults to 64 MiB; 0 disables the byte budget. */
  cacheBytes?: number;
}

export interface SearchHit {
  key: string;
  score: number;
}

export interface SearchOptions {
  op?: 'AND' | 'OR';
  limit?: number;
  /**
   * Max posting entries visited (decoded + merged) across all query terms.
   * Terms are decoded most-selective-first and a term whose list would
   * overflow the remaining budget contributes only its leading prefix, so an
   * exhausted budget yields a SUBSET of the full matches — never false hits.
   * Detect the shortfall via `searchBounded`'s `truncated` flag; plain
   * `search` keeps returning just the (possibly partial) hits.
   */
  maxVisits?: number;
}

/** `search` outcome with its work accounting (see SearchOptions.maxVisits). */
export interface BoundedSearchResult {
  readonly hits: SearchHit[];
  /** Posting entries actually visited across all query terms. */
  readonly visits: number;
  /** True when `maxVisits` cut one or more postings lists short. */
  readonly truncated: boolean;
}

/** Staged text-index rebuild (see TextIndex.beginBuild): feed docs with
 *  add(), swap everything in with commit(), or discard with abort(). */
export interface TextIndexBuild {
  /** Stage one document; returns its token count (feeds yield watermarks). */
  add(key: string, value: unknown): number;
  commit(): Promise<void>;
  abort(): void;
}

export const EMPTY_MAP: ReadonlyMap<number, number> = new Map();

/** One write that landed while a `build()` was in flight (see buildQueue).
 *  Carries the VALIDATED mutation — key + precomputed tokens, never the raw
 *  doc — so the swap-time replay cannot throw on a tokenizer failure
 *  (review #24). */
export type BuildOp =
  | { readonly kind: 'add'; readonly key: string; readonly tokens: readonly string[] }
  | { readonly kind: 'remove'; readonly key: string };

/** Bounded collector for the K best hits by (score desc, key asc). The heap
 *  root holds the WORST kept hit, so a new candidate enters only when it beats
 *  that root — O(log K) per candidate and K kept in memory, instead of an
 *  O(C log C) full sort over every candidate. The key tie-break keeps the
 *  order of equal-score hits stable across paginated queries. */
export class TopK {
  private readonly a: SearchHit[] = [];

  constructor(private readonly k: number) {}

  /** x ranks strictly after y (smaller score, or equal score with larger key). */
  private static worse(x: SearchHit, y: SearchHit): boolean {
    return x.score < y.score || (x.score === y.score && x.key > y.key);
  }

  offer(hit: SearchHit): void {
    const a = this.a;
    if (a.length < this.k) {
      a.push(hit);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!TopK.worse(a[i]!, a[p]!)) break; // parent is worse -> heap holds
        [a[p], a[i]] = [a[i]!, a[p]!];
        i = p;
      }
      return;
    }
    if (this.k === 0 || !TopK.worse(a[0]!, hit)) return; // must beat the worst kept
    a[0] = hit;
    let i = 0;
    for (;;) {
      let w = i; // index of the worst among {i, left, right}
      const l = 2 * i + 1;
      const r = l + 1;
      if (l < a.length && TopK.worse(a[l]!, a[w]!)) w = l;
      if (r < a.length && TopK.worse(a[r]!, a[w]!)) w = r;
      if (w === i) break;
      [a[w], a[i]] = [a[i]!, a[w]!];
      i = w;
    }
  }

  /** The kept hits in final rank order: score descending, key ascending. */
  sorted(): SearchHit[] {
    return this.a.toSorted((x, y) => y.score - x.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  }
}
