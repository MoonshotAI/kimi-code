// src/text-index/builder.ts
//
// The staged rebuild aggregator behind TextIndex.build()/beginBuild(). It is
// self-contained: everything it needs from the owning TextIndex is injected
// through StagedBuildHooks (the tokenize-and-validate boundary, the commit
// that swaps the staged base in, and the queue disarm), so this module never
// imports the TextIndex class itself.

import { yieldToLoop } from './tokenize.js';
import type { TextIndexBuild } from './types.js';

// `build()` yields to the event loop at the first of these two watermarks, so
// many-small-docs and few-huge-docs corpora are both bounded per slice. The
// docs watermark doubles as the stage-6 per-slice CPU budget: n-gram
// tokenization costs ~35µs/doc, so 512 docs bounds a slice at ~20ms even on
// the (explicitly degraded) in-thread fallback path.
const BUILD_YIELD_DOCS = 512;
const BUILD_YIELD_TOKENS = 500_000;

/** The fully staged rebuild state, handed to the commit hook at commit(). */
export interface StagedBuildState {
  agg: Map<string, Map<number, number>>; // term -> (docID -> freq)
  keys: (string | undefined)[]; // docID -> key
  keyToId: Map<string, number>; // key -> docID
  docLens: Map<number, number>; // docID -> token count
  n: number;
}

/** The owner-injected surface a staged build needs (see the header). */
export interface StagedBuildHooks {
  /** Extract + tokenize + validate a document (the write path's boundary). */
  tokensFor(value: unknown): string[];
  /** Swap the staged base into the live index (see TextIndex.beginBuild). */
  commit(staged: StagedBuildState): Promise<void>;
  /** Drop the owner's build queue on abort/failure. */
  disarm(): void;
}

/** Staged text-index rebuild (see TextIndex.beginBuild): feed docs with
 *  add(), swap everything in with commit(), or discard with abort(). */
export class StagedBuild implements TextIndexBuild {
  // Staged state.
  private readonly agg = new Map<string, Map<number, number>>(); // term -> (docID -> freq)
  private readonly newKeys: (string | undefined)[] = []; // docID -> key
  private readonly newKeyToId = new Map<string, number>(); // key -> docID
  private readonly newDocLen = new Map<number, number>(); // docID -> token count
  private n = 0;
  private done = false;

  constructor(private readonly hooks: StagedBuildHooks) {}

  add(key: string, value: unknown): number {
    if (this.done) throw new Error('text index build already finished');
    // Tokenize (and validate) BEFORE staging anything: a throwing
    // tokenizer must not leave a ghost docID in the staged state.
    const tokens = this.hooks.tokensFor(value);
    const docID = this.newKeys.length;
    this.newKeys.push(key);
    this.newKeyToId.set(key, docID);
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, c] of counts) {
      let m = this.agg.get(t);
      if (!m) this.agg.set(t, (m = new Map()));
      m.set(docID, c); // docIDs increase monotonically -> insertion order is sorted
    }
    this.newDocLen.set(docID, tokens.length);
    this.n++;
    return tokens.length;
  }

  async commit(): Promise<void> {
    if (this.done) throw new Error('text index build already finished');
    this.done = true;
    try {
      await this.hooks.commit({
        agg: this.agg,
        keys: this.newKeys,
        keyToId: this.newKeyToId,
        docLens: this.newDocLen,
        n: this.n,
      });
    } catch (error) {
      // Staging never touched the live view, so the previous index is
      // intact; the queued ops were already applied to it — just disarm.
      this.hooks.disarm();
      throw error;
    }
  }

  // Nothing staged on disk yet (the postings write only happens inside
  // commit): disarming the queue and dropping the reference is the whole
  // abort.
  abort(): void {
    if (this.done) return;
    this.done = true;
    this.hooks.disarm();
  }
}

/** The build() feeding loop: push every entry through the staged build,
 *  yielding to the event loop at the watermarks above so a large rebuild
 *  never hard-blocks the host process, then commit (abort on failure). */
export async function feedBuild(
  b: TextIndexBuild,
  entries: Iterable<{ key: string; value: unknown }>,
): Promise<void> {
  let docsSinceYield = 0;
  let tokensSinceYield = 0;
  try {
    for (const { key, value } of entries) {
      tokensSinceYield += b.add(key, value);
      docsSinceYield++;
      if (docsSinceYield >= BUILD_YIELD_DOCS || tokensSinceYield >= BUILD_YIELD_TOKENS) {
        docsSinceYield = 0;
        tokensSinceYield = 0;
        await yieldToLoop();
      }
    }
  } catch (error) {
    b.abort();
    throw error;
  }
  await b.commit();
}
