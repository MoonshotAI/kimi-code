// src/text-index/image.ts
//
// Stage-5 generation image export/attach and postings repointing. The
// functions operate on an explicitly passed state view (TextIndexImageState)
// of the owning TextIndex instead of importing the class itself — TextIndex
// satisfies the view structurally and delegates its same-named methods here.

import { PostingsFile } from '../text-postings.js';
import type { PostingEntry } from '../text-postings.js';
import { yieldToLoop } from './tokenize.js';

/** The serialized image of a text index (the stage-5 generation checkpoint):
 *  dictionary, doc table, tombstones, and the write buffer. */
export interface TextIndexImage {
  dict: Map<string, PostingEntry>;
  keys: (string | undefined)[];
  docLens: Map<number, number>;
  liveCount: number;
  removed: Set<number>;
  delta: Map<string, Map<number, number>>;
}

/** The slice of TextIndex state the image functions read/mutate. The class
 *  keeps these fields non-private (package-internal by convention) exactly so
 *  they can be grouped into this explicit view — see TextIndex. */
export interface TextIndexImageState {
  postings: Map<string, PostingEntry>;
  memBase: Map<string, Map<number, number>> | null;
  pf: PostingsFile | null;
  docLen: Map<number, number>;
  keys: (string | undefined)[];
  keyToId: Map<string, number>;
  delta: Map<string, Map<number, number>>;
  deltaDocs: Map<number, Set<string>>;
  deltaCount: number;
  removed: Set<number>;
  N: number;
  basePending: boolean;
  baseEpoch: number;
  clearCache(): void;
  close(): void;
}

/** Stage-5 generation build: a synchronous deep-enough snapshot of the live
 *  state for image serialization. The maps/arrays are copied so later
 *  mutations of the live index never reach the serialized image. Must run
 *  while no build is in flight (a committed build's state is what a
 *  generation serializes). */
export function exportImageState(
  s: Pick<TextIndexImageState, 'postings' | 'keys' | 'docLen' | 'N' | 'removed' | 'delta'>,
): TextIndexImage {
  return {
    dict: new Map(s.postings),
    keys: [...s.keys],
    docLens: new Map(s.docLen),
    liveCount: s.N,
    removed: new Set(s.removed),
    delta: new Map([...s.delta].map(([t, m]) => [t, new Map(m)])),
  };
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
export async function exportImageStateAsync(
  s: Pick<TextIndexImageState, 'postings' | 'keys' | 'docLen' | 'N' | 'removed' | 'delta'>,
  opts: { sliceEvery?: number } = {},
): Promise<TextIndexImage> {
  const sliceEvery = opts.sliceEvery ?? 65536;
  let n = 0;
  const tick = async (): Promise<void> => {
    if (++n % sliceEvery === 0) await yieldToLoop();
  };
  const dict = new Map<string, PostingEntry>();
  for (const [t, e] of s.postings) {
    dict.set(t, e);
    await tick();
  }
  const delta = new Map<string, Map<number, number>>();
  for (const [t, m] of s.delta) {
    delta.set(t, new Map(m));
    await tick();
  }
  const removed = new Set<number>();
  for (const id of s.removed) {
    removed.add(id);
    await tick();
  }
  const docLens = new Map<number, number>();
  for (const [id, len] of s.docLen) {
    docLens.set(id, len);
    await tick();
  }
  // keys LAST (see the header) — then the doc-count read, so it never
  // under-counts relative to the copied table.
  const keys = [...s.keys];
  return { dict, keys, docLens, liveCount: s.N, removed, delta };
}

/** Stage-5 generation load: attach a persisted base + write-buffer state,
 *  making the index exactly equal to the one the generation sealed —
 *  dictionary, doc table, tombstones and delta included. Any previous state
 *  is replaced; a memory-base instance switches to disk-base on the
 *  generation's postings file (read-only opens attach the same way — the
 *  file is only ever read). */
export function attachImage(
  s: TextIndexImageState,
  args: { postingsPath: string } & TextIndexImage,
): void {
  s.close(); // release any previous postings handle
  s.memBase = null;
  s.postings.clear();
  for (const [t, e] of args.dict) s.postings.set(t, e);
  s.pf = PostingsFile.open(args.postingsPath);
  s.docLen.clear();
  for (const [id, len] of args.docLens) s.docLen.set(id, len);
  s.keys.length = 0;
  for (const k of args.keys) s.keys.push(k);
  s.keyToId.clear();
  for (let i = 0; i < s.keys.length; i++) {
    const k = s.keys[i];
    if (k !== undefined) s.keyToId.set(k, i);
  }
  s.delta.clear();
  s.deltaDocs.clear();
  s.deltaCount = 0;
  for (const [t, m] of args.delta) {
    s.delta.set(t, m);
    for (const [id] of m) {
      s.deltaCount++;
      let set = s.deltaDocs.get(id);
      if (!set) s.deltaDocs.set(id, (set = new Set()));
      set.add(t);
    }
  }
  s.removed.clear();
  for (const id of args.removed) s.removed.add(id);
  s.clearCache();
  s.N = args.liveCount;
  // A committed base is now attached — the index no longer owes a build, and
  // any async read in flight must re-read from the attached base.
  s.basePending = false;
  s.baseEpoch++;
}

/** The raw parsed images attachImageAsync consumes (the generation loader's
 *  readTextDictionaryImageAsync / readTextDocsImageAsync output, structurally
 *  — avoiding a gen-codec import here). */
export interface AttachImageRaw {
  postingsPath: string;
  dictEntries: Iterable<{ term: string; off: number; len: number; df: number }>;
  docs: {
    keys: (string | undefined)[];
    docLens: (number | undefined)[];
    liveCount: number;
    removed: number[];
    delta: { term: string; docs: { docID: number; freq: number }[] }[];
  };
}

/** Sliced variant of attachImage (the open-time main-thread path): identical
 *  resulting state and the same side-effect order, but every O(terms/docs)
 *  map construction happens here, in slices with event-loop yields, so
 *  attaching a large generation's base never stalls the loop for the whole
 *  pass. Safe to yield mid-attach: the index is not serving until open()
 *  returns, and the readonly-bound containers (delta, deltaDocs, removed —
 *  their bindings are stable by class invariant) are cleared-then-refilled
 *  in place exactly like the sync attach, only with yields interleaved. */
export async function attachImageAsync(
  s: TextIndexImageState,
  args: AttachImageRaw,
  opts: { sliceEvery?: number } = {},
): Promise<void> {
  const sliceEvery = opts.sliceEvery ?? 32768;
  let n = 0;
  const tick = async (): Promise<void> => {
    if (++n % sliceEvery === 0) await yieldToLoop();
  };
  s.close(); // release any previous postings handle
  s.memBase = null;
  const postings = new Map<string, PostingEntry>();
  for (const e of args.dictEntries) {
    postings.set(e.term, { off: e.off, len: e.len, df: e.df });
    await tick();
  }
  s.postings = postings;
  s.pf = PostingsFile.open(args.postingsPath);
  const keys = args.docs.keys; // adopted (fresh from the parser — see commitRebase's containers)
  const docLen = new Map<number, number>();
  for (let i = 0; i < keys.length; i++) {
    const len = args.docs.docLens[i];
    if (len !== undefined) docLen.set(i, len);
    await tick();
  }
  const keyToId = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k !== undefined) keyToId.set(k, i);
    await tick();
  }
  s.docLen = docLen;
  s.keys = keys;
  s.keyToId = keyToId;
  s.delta.clear();
  s.deltaDocs.clear();
  s.deltaCount = 0;
  for (const d of args.docs.delta) {
    const m = new Map<number, number>();
    s.delta.set(d.term, m);
    for (const doc of d.docs) {
      m.set(doc.docID, doc.freq);
      s.deltaCount++;
      let set = s.deltaDocs.get(doc.docID);
      if (!set) s.deltaDocs.set(doc.docID, (set = new Set()));
      set.add(d.term);
      await tick();
    }
  }
  s.removed.clear();
  for (const id of args.docs.removed) {
    s.removed.add(id);
    await tick();
  }
  s.clearCache();
  s.N = args.docs.liveCount;
  // A committed base is now attached — the index no longer owes a build, and
  // any async read in flight must re-read from the attached base.
  s.basePending = false;
  s.baseEpoch++;
}

/** Stage-5 generation build: after the atomic publish rename, repoint the
 *  live base handle from the build's tmp directory to the published
 *  generation directory (same file, final name). On Windows an open handle
 *  would have blocked the directory rename, so the caller closes before the
 *  rename and reopens here; POSIX just updates the path (the fd stays valid
 *  across the rename). A reopen failure degrades reads to delta-only until
 *  the next build, exactly like commitBuild's reopen failure. */
export function repointPostings(s: Pick<TextIndexImageState, 'pf'>, newPath: string): void {
  if (!s.pf) return;
  if (process.platform === 'win32') {
    s.pf.close();
    s.pf = null;
    try {
      s.pf = PostingsFile.open(newPath);
    } catch {
      /* degrade to delta-only reads; the next successful build fixes it */
    }
    return;
  }
  s.pf.path = newPath;
}
