// packages/app-core/src/lib/transcriptSearch.ts

// Transcript find bar (Cmd/Ctrl+F): the search engine behind
// components/chat/TranscriptSearch.vue. Matches are Ranges over the rendered
// transcript DOM, painted via the CSS Custom Highlight API (browser
// find-in-page idiom).

export interface FindKeyEventLike {
  key: string;
  /** Physical key code (KeyboardEvent.code) — layout-independent. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

export interface ApplePlatformLike {
  (): boolean;
}

// Local copy of the platform check, mirroring transcriptSelectAll.ts's
// isApplePlatform (kept separate so this file stays self-contained for the
// apps/web snapshot sync).
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  return userAgentData?.platform === 'macOS' || userAgentData?.platform === 'iOS';
}

/** Exact platform find-in-page (⌘F / Ctrl+F, no extra modifiers), matching
 *  the physical F key first — same idiom as transcriptSelectAll.ts. */
export function isFindKeyEvent(
  event: FindKeyEventLike,
  apple: boolean = isApplePlatform(),
): boolean {
  const findModifier = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return (
    findModifier &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyF' || event.key.toLowerCase() === 'f') &&
    !event.defaultPrevented
  );
}

export interface TextMatch {
  /** Start offset in the ORIGINAL text (UTF-16 units). */
  start: number;
  /** End offset (exclusive) in the ORIGINAL text. */
  end: number;
}

// Already-lowercase chars whose Unicode casefold differs from identity —
// browser find matches on the folded form, so both sides must be mapped.
const CASEFOLD_SUPPLEMENT = new Map<string, string>([
  ['ς', 'σ'], // Greek final sigma
  ['ß', 'ss'],
  ['ſ', 's'], // Latin long s
  ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'],
  ['ﬅ', 'st'], ['ﬆ', 'st'],
  ['ŉ', 'ʼn'],
  ['µ', 'μ'], // micro sign → Greek small mu
  ['K', 'k'], // Kelvin sign
  ['Å', 'å'], // Angstrom sign
  ['Ω', 'ω'], // Ohm sign
]);

// CSS white-space modes: normal/nowrap collapse runs to one space, pre-line
// collapses spaces/tabs but keeps newlines, pre/pre-wrap/break-spaces are
// verbatim. find-in-page matches the RENDERED text, not nodeValue.
export type WhitespaceMode = 'collapse' | 'pre-line' | 'preserve';

export function whitespaceModeOf(computedWhiteSpace: string): WhitespaceMode {
  if (
    computedWhiteSpace === 'pre' ||
    computedWhiteSpace === 'pre-wrap' ||
    computedWhiteSpace === 'break-spaces'
  ) {
    return 'preserve';
  }
  if (computedWhiteSpace === 'pre-line') return 'pre-line';
  return 'collapse';
}

/** `text` as rendered under `mode`, plus for every rendered unit the raw-unit
 *  index that produced it (rendered→Range-offset conversion). */
export function collapseWhitespaceWithMap(
  text: string,
  mode: WhitespaceMode,
): { text: string; map: number[] } {
  if (mode === 'preserve') {
    return { text, map: Array.from({ length: text.length }, (_, i) => i) };
  }
  const collapsible = mode === 'collapse' ? /[\t\n\f\r ]/ : /[\t ]/;
  let out = '';
  const map: number[] = [];
  let inRun = false;
  for (let i = 0; i < text.length; i++) {
    if (collapsible.test(text[i]!)) {
      if (!inRun) {
        out += ' ';
        map.push(i);
        inRun = true;
      }
    } else {
      out += text[i]!;
      map.push(i);
      inRun = false;
    }
  }
  return { text: out, map };
}

/** Case-folded form of `text` plus, for every folded unit, the offset and
 *  length of the producing original code point. Folding runs per code point
 *  and can CHANGE length (İ → i̇), so folded offsets are only valid Range
 *  offsets via this map. */
export function foldCaseWithMap(text: string): {
  folded: string;
  map: { start: number; length: number }[];
} {
  let folded = '';
  const map: { start: number; length: number }[] = [];
  let i = 0;
  for (const cp of text) {
    // Lowercase FIRST, then supplement (ẞ→ß→ss).
    const lowered = cp.toLowerCase();
    const foldedCp = CASEFOLD_SUPPLEMENT.get(lowered) ?? lowered;
    folded += foldedCp;
    for (let j = 0; j < foldedCp.length; j++) map.push({ start: i, length: cp.length });
    i += cp.length;
  }
  return { folded, map };
}

/** Every non-overlapping occurrence of `query` in `text`, case-insensitive,
 *  as offsets in the ORIGINAL text (safe Range offsets). */
export function findOccurrences(text: string, query: string): TextMatch[] {
  return findMatchesInSegments([{ text, gapBefore: true }], query).map((m) => ({
    start: m.startOffset,
    end: m.endOffset,
  }));
}

export interface SegmentText {
  /** One text node's data. */
  text: string;
  /** True when a block boundary precedes this segment (no match crosses it). */
  gapBefore: boolean;
}

export interface SegmentMatch {
  /** Index of the segment the match starts in. */
  startSeg: number;
  /** Start offset in the ORIGINAL text of that segment (UTF-16 units). */
  startOffset: number;
  /** Index of the segment the match ends in (matches may span segments
      within one block, e.g. across <strong> or highlight spans). */
  endSeg: number;
  /** End offset (exclusive) in the ORIGINAL text of that segment. */
  endOffset: number;
}

/** Every non-overlapping occurrence of `query` across the given text runs,
 *  case-insensitive, in document order, as ORIGINAL-text offsets (see
 *  foldCaseWithMap). */
export function findMatchesInSegments(segments: SegmentText[], query: string): SegmentMatch[] {
  return [...matchSegmentsLazy(segments, query)];
}

/** Lazy core of findMatchesInSegments — yields matches one at a time so a
 *  capped collector never pays for the whole result set. */
export function* matchSegmentsLazy(
  segments: SegmentText[],
  query: string,
): Generator<SegmentMatch, void, void> {
  if (query.length === 0 || segments.length === 0) return;
  const folds = segments.map((segment) => foldCaseWithMap(segment.text));
  // NUL separates blocks: neither real text nor \s can match it.
  const BLOCK_SEP = '\u0000';
  let haystack = '';
  const segFoldStart: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0 && segments[i]!.gapBefore) haystack += BLOCK_SEP;
    segFoldStart[i] = haystack.length;
    haystack += folds[i]!.folded;
  }
  // Whitespace in the query is semantic: a run matches any whitespace run
  // in the text (regex over the folded strings).
  const pattern = needlePattern(foldCaseWithMap(query).folded);
  if (pattern === null) return;
  const needleRe = new RegExp(pattern, 'g');
  // Segment index containing folded position `pos` (last start ≤ pos).
  function locate(pos: number): number {
    let lo = 0;
    let hi = segFoldStart.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segFoldStart[mid]! <= pos) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }
  let prev: SegmentMatch | undefined;
  for (;;) {
    const m = needleRe.exec(haystack);
    if (m === null) return;
    const hit = m.index;
    const endPos = hit + m[0].length - 1;
    const startSeg = locate(hit);
    const endSeg = locate(endPos);
    const startMap = folds[startSeg]!.map[hit - segFoldStart[startSeg]!]!;
    const endMap = folds[endSeg]!.map[endPos - segFoldStart[endSeg]!]!;
    const match: SegmentMatch = {
      startSeg,
      startOffset: startMap.start,
      endSeg,
      endOffset: endMap.start + endMap.length,
    };
    // Folded-expansion duplicate: one original code point folding to several
    // chars (ß→ss) makes consecutive hits map to the SAME original span.
    if (
      prev !== undefined &&
      prev.startSeg === match.startSeg &&
      prev.startOffset === match.startOffset &&
      prev.endSeg === match.endSeg &&
      prev.endOffset === match.endOffset
    ) {
      continue;
    }
    prev = match;
    yield match;
  }
}

// Regex specials get escaped per literal run; whitespace runs become \s+.
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** Compile a folded query into a regex source: whitespace runs → `\s+`,
 *  everything else literal. Null only for an empty query. */
export function needlePattern(foldedQuery: string): string | null {
  const parts: string[] = [];
  let i = 0;
  while (i < foldedQuery.length) {
    const ws = /^\s+/.exec(foldedQuery.slice(i));
    if (ws !== null) {
      parts.push('\\s+');
      i += ws[0].length;
      continue;
    }
    const lit = /^[^\s]+/.exec(foldedQuery.slice(i))!;
    parts.push(lit[0].replaceAll(REGEX_SPECIALS, '\\$&'));
    i += lit[0].length;
  }
  return parts.length === 0 ? null : parts.join('');
}

// Subtrees excluded from search: non-content elements, collapsed (inert)
// turn-fold bodies, and the load-older chrome.
const SKIP_SUBTREE_SELECTOR = 'script, style, noscript, template, [inert], .top-sentinel';

// Text nodes under the SAME nearest block ancestor form one visible run.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const INLINE_DISPLAYS = new Set([
  'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
  'contents', 'ruby',
]);

/** True for elements that break the visible text run — block-level by tag or
 *  by computed display (e.g. shiki's inline-tag line spans styled as blocks). */
function isBlockLevel(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const hit = cache.get(el);
  if (hit !== undefined) return hit;
  const block =
    BLOCK_TAGS.has(el.tagName) || !INLINE_DISPLAYS.has(getComputedStyle(el).display);
  cache.set(el, block);
  return block;
}

/** Nearest block-level ancestor of a text node, climbing no higher than
 *  `root` — two text nodes share one visible run iff this is the same
 *  element for both. */
function blockAncestor(node: Node, root: Element, cache: WeakMap<Element, boolean>): Element {
  let el = node.parentElement;
  while (el !== null && el !== root && !isBlockLevel(el, cache)) {
    el = el.parentElement;
  }
  return el ?? root;
}

/** Result-set cap (VS Code's find precedent) — beyond this a query is too
 *  broad to navigate anyway. */
export const MAX_MATCHES = 1000;

/** One Range per occurrence of `query` across the text nodes under `root`,
 *  in document order, capped at MAX_MATCHES (`truncated` when capped). Pure
 *  DOM reads — nothing is painted or mutated. */
export function collectMatchRanges(
  root: Element,
  query: string,
): { ranges: Range[]; truncated: boolean } {
  if (query.length === 0) return { ranges: [], truncated: false };
  const doc = root.ownerDocument;
  // SHOW_ELEMENT | SHOW_TEXT so the filter can reject whole skipped subtrees
  // instead of walking into them node by node.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).matches(SKIP_SUBTREE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        // Text-less visible breaks split the run even when both neighbors
        // share a block ancestor (<p>foo<br>bar</p> must not match 'foobar').
        if ((node as Element).matches('br, hr, wbr') && !(node as Element).closest(SKIP_SUBTREE_SELECTOR)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // Gather the visible text runs first, then match across them in one pass.
  // Text is collapsed per its element's white-space mode (rendered text, not
  // nodeValue); wsMap converts rendered offsets back to raw node offsets.
  const blockCache = new WeakMap<Element, boolean>();
  const wsModeCache = new WeakMap<Element, WhitespaceMode>();
  const segments: {
    text: string;
    gapBefore: boolean;
    node: Node;
    block: Element;
    wsMap: number[];
  }[] = [];
  let pendingGap = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      pendingGap = true; // a <br>/<hr>/<wbr> — the next run starts a new line
      continue;
    }
    const raw = node.nodeValue ?? '';
    if (raw.length === 0) continue;
    const parent = node.parentElement;
    if (parent === null) continue;
    let mode = wsModeCache.get(parent);
    if (mode === undefined) {
      mode = whitespaceModeOf(getComputedStyle(parent).whiteSpace);
      wsModeCache.set(parent, mode);
    }
    let { text, map: wsMap } = collapseWhitespaceWithMap(raw, mode);
    if (text.length === 0) continue;
    const block = blockAncestor(node, root, blockCache);
    const prev = segments.at(-1);
    const gapBefore = pendingGap || prev === undefined || prev.block !== block;
    // A whitespace run spanning an inline boundary renders as ONE space.
    if (!gapBefore && prev!.text.endsWith(' ') && text.startsWith(' ')) {
      text = text.slice(1);
      wsMap = wsMap.slice(1);
      if (text.length === 0) continue;
    }
    segments.push({ text, gapBefore, node, block, wsMap });
    pendingGap = false;
  }
  const ranges: Range[] = [];
  for (const match of matchSegmentsLazy(segments, query)) {
    const startSeg = segments[match.startSeg]!;
    const endSeg = segments[match.endSeg]!;
    const range = doc.createRange();
    range.setStart(startSeg.node, startSeg.wsMap[match.startOffset]!);
    range.setEnd(endSeg.node, endSeg.wsMap[match.endOffset - 1]! + 1);
    // No layout box = hidden (v-show/display:none): would inflate the count
    // and navigate nowhere.
    if (range.getClientRects().length === 0) continue;
    // Truncation is judged by the (MAX+1)-th VISIBLE match.
    if (ranges.length >= MAX_MATCHES) return { ranges, truncated: true };
    ranges.push(range);
  }
  return { ranges, truncated: false };
}

// Highlight registry names — the pairing ::highlight() rules live in the
// app's global style.css (highlight pseudos can't be component-scoped).
const HIGHLIGHT_ALL = 'kimi-transcript-search';
const HIGHLIGHT_CURRENT = 'kimi-transcript-search-current';

type HighlightRegistryLike = { set(name: string, highlight: unknown): void; delete(name: string): void };
type HighlightInstanceLike = { add(range: Range): void };

function highlightsRegistry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return css?.highlights ?? null;
}

/** Paint all matches plus a stronger current-match highlight. No-op where
 *  the CSS Custom Highlight API is missing. */
export function setSearchHighlights(ranges: Range[], currentIndex: number): void {
  const registry = highlightsRegistry();
  const HighlightCtor = (
    globalThis as { Highlight?: new () => HighlightInstanceLike }
  ).Highlight;
  if (!registry || !HighlightCtor) return;
  if (ranges.length === 0) {
    clearSearchHighlights();
    return;
  }
  // add() per range: spreading a large set into constructor arguments
  // overflows V8's argument limit.
  const all = new HighlightCtor();
  for (const range of ranges) all.add(range);
  registry.set(HIGHLIGHT_ALL, all);
  const current = ranges[currentIndex];
  if (current !== undefined) {
    const currentHighlight = new HighlightCtor();
    currentHighlight.add(current);
    registry.set(HIGHLIGHT_CURRENT, currentHighlight);
  } else {
    registry.delete(HIGHLIGHT_CURRENT);
  }
}

export function clearSearchHighlights(): void {
  const registry = highlightsRegistry();
  registry?.delete(HIGHLIGHT_ALL);
  registry?.delete(HIGHLIGHT_CURRENT);
}
