// src/text-index/tokenize.ts
//
// Tokenizer of the full-text index: Latin/number words + CJK unigrams &
// bigrams (no dictionary, zero dependencies, works for Chinese without a
// segmenter), plus the document text extraction shared with the generation
// build's worker. This file is part of the worker's import closure, so every
// relative import carries an explicit `.ts` specifier (see the IMPORT NOTE in
// worker/text-build-core.ts).

import { getPath } from '../query.ts';

const LATIN = /[a-z0-9]+/g;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uff00-\uffef]+/g;
// Postings records store the term length in a uint16. A single document with a
// longer token previously made every postings rebuild throw after the index had
// already been cleared, permanently poisoning the index (and compaction). Such
// tokens can never be real query terms — drop them at tokenization so one
// pathological document cannot destroy the index.
const MAX_TERM_CHARS = 0xffff;
// The same postings uint16 limit in UTF-8 BYTES (encodeRecord's unit). A
// custom tokenizer's output is validated against it at every write boundary
// (tokensFor): an overlong term rejects the write loudly instead of poisoning
// the next postings rebuild (review #27).
export const MAX_TERM_BYTES = 0xffff;

export const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

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

/** Extract the indexable text of a document (shared with the generation
 *  build's worker: fields mode joins the configured paths, otherwise every
 *  string leaf). Internal to the package. */
export function extractText(fields: readonly string[] | null, doc: unknown): string {
  if (fields && fields.length) {
    return fields
      .map((f) => getPath(doc, f))
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return stringLeaves(doc).join(' ');
}
