// src/trigram.ts
//
// n-gram (2-gram + 3-gram) substring tokenizer for literal search.
//
// A TextIndex with this tokenizer indexes hashed character n-grams instead of
// words, so symbol-heavy text (`C++`, `$\frac{a}{b}$`, `**passed**`, emoji)
// becomes searchable as exact substrings. The index only yields candidates —
// zero false positives is guaranteed by a downstream confirmation step that
// re-checks `normalizeLiteral(doc).includes(normalizeLiteral(query))` against
// the original text; hash collisions and non-contiguous n-gram matches only
// cost extra confirmations.
//
// Deliberate deviations from the reference (Elasticsearch `wildcard` field):
//   - Case-insensitive: NFKC + lowercase, aligned with the default tokenizer.
//   - Windows are cut by Unicode code point (Array.from), not UTF-16 code
//     unit, so surrogate pairs (emoji) are never split.
//   - n-grams hash into 2^HASH_BITS buckets via the existing crc32 (no new
//     deps); 2-grams and 3-grams carry distinct tag prefixes so their buckets
//     never alias.

import { crc32 } from './crc32.js';

/** Tokenizer kinds that can be persisted in a text index definition
 *  (`db.textindexes.json`). A definition without the field (written before
 *  n-gram support existed) means 'default'. */
export type TextIndexTokenizerName = 'default' | 'ngram';

/** Width of the n-gram hash space in bits (4M buckets). Collisions only add
 *  confirmation work downstream; they never affect correctness. */
const HASH_BITS = 22;
const HASH_MASK = (1 << HASH_BITS) - 1;

/** Normalize text for literal matching: Unicode NFKC (fullwidth `＄` -> `$`,
 *  compatibility glyphs folded) + lowercase. The search layer's confirmation
 *  step must use this exact function so index and comparison agree. */
export function normalizeLiteral(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function termFor(gram: string, width: number): string {
  const hash = crc32(Buffer.from(gram, 'utf8')) & HASH_MASK;
  return String(width) + hash.toString(36);
}

/** Encode one n-gram (2 or 3 code points) as an index term: a width tag plus
 *  the low HASH_BITS of its crc32 in base 36. Deterministic across processes. */
export function ngramTerm(gram: string): string {
  const width = Array.from(gram).length;
  if (width !== 2 && width !== 3) {
    throw new RangeError(`ngramTerm expects a 2- or 3-gram, got ${width} code points`);
  }
  return termFor(gram, width);
}

export interface NgramTokenizerOptions {
  /** Query side: a length-2 query emits only its 2-gram, a longer query only
   *  its 3-grams (fewer, more selective terms). Index side (the default)
   *  emits every 3-gram plus every 2-gram so both query shapes can match.
   *  Text shorter than 2 normalized code points yields no terms — the search
   *  layer must reject such queries itself. */
  forQuery?: boolean;
}

/** Build a tokenizer that maps text to hashed n-gram terms (see file header).
 *  Windows slide over code points, so astral characters stay whole. */
export function createNgramTokenizer(opts: NgramTokenizerOptions = {}): (text: string) => string[] {
  return (text) => {
    const chars = Array.from(normalizeLiteral(text));
    const n = chars.length;
    const terms: string[] = [];
    if (n < 2) return terms;
    const widths = opts.forQuery ? (n === 2 ? [2] : [3]) : n >= 3 ? [3, 2] : [2];
    for (const w of widths) {
      for (let i = 0; i + w <= n; i++) {
        terms.push(termFor(chars.slice(i, i + w).join(''), w));
      }
    }
    return terms;
  };
}
