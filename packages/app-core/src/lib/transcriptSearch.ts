import { isApplePlatform } from './shortcutKeys';

export interface FindKeyEventLike {
  key: string;
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
  start: number;
  end: number;
}

const CASEFOLD_SUPPLEMENT = new Map<string, string>([
  ['ς', 'σ'],
  ['ß', 'ss'],
  ['ſ', 's'],
  ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'],
  ['ﬅ', 'st'], ['ﬆ', 'st'],
  ['ŉ', 'ʼn'],
  ['µ', 'μ'],
  ['K', 'k'],
  ['Å', 'å'],
  ['Ω', 'ω'],
]);

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

export function foldCaseWithMap(text: string): {
  folded: string;
  map: { start: number; length: number }[];
} {
  let folded = '';
  const map: { start: number; length: number }[] = [];
  let i = 0;
  for (const cp of text) {
    const lowered = cp.toLowerCase();
    const foldedCp = CASEFOLD_SUPPLEMENT.get(lowered) ?? lowered;
    folded += foldedCp;
    for (let j = 0; j < foldedCp.length; j++) map.push({ start: i, length: cp.length });
    i += cp.length;
  }
  return { folded, map };
}

export function findOccurrences(text: string, query: string): TextMatch[] {
  return findMatchesInSegments([{ text, gapBefore: true }], query).map((m) => ({
    start: m.startOffset,
    end: m.endOffset,
  }));
}

export interface SegmentText {
  text: string;
  gapBefore: boolean;
}

export interface SegmentMatch {
  startSeg: number;
  startOffset: number;
  endSeg: number;
  endOffset: number;
}

export function findMatchesInSegments(segments: SegmentText[], query: string): SegmentMatch[] {
  return [...matchSegmentsLazy(segments, query)];
}

export function* matchSegmentsLazy(
  segments: SegmentText[],
  query: string,
): Generator<SegmentMatch, void, void> {
  if (query.length === 0 || segments.length === 0) return;
  const folds = segments.map((segment) => foldCaseWithMap(segment.text));
  const BLOCK_SEP = '\u0000';
  let haystack = '';
  const segFoldStart: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i > 0 && segments[i]!.gapBefore) haystack += BLOCK_SEP;
    segFoldStart[i] = haystack.length;
    haystack += folds[i]!.folded;
  }
  const pattern = needlePattern(foldCaseWithMap(query).folded);
  if (pattern === null) return;
  const needleRe = new RegExp(pattern, 'g');
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

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

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

const SKIP_SUBTREE_SELECTOR = 'script, style, noscript, template, [inert], .top-sentinel';

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

function isBlockLevel(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const hit = cache.get(el);
  if (hit !== undefined) return hit;
  const block =
    BLOCK_TAGS.has(el.tagName) || !INLINE_DISPLAYS.has(getComputedStyle(el).display);
  cache.set(el, block);
  return block;
}

function blockAncestor(node: Node, root: Element, cache: WeakMap<Element, boolean>): Element {
  let el = node.parentElement;
  while (el !== null && el !== root && !isBlockLevel(el, cache)) {
    el = el.parentElement;
  }
  return el ?? root;
}

export const MAX_MATCHES = 1000;

export function collectMatchRanges(
  root: Element,
  query: string,
): { ranges: Range[]; truncated: boolean } {
  if (query.length === 0) return { ranges: [], truncated: false };
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).matches(SKIP_SUBTREE_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if ((node as Element).matches('br, hr, wbr') && !(node as Element).closest(SKIP_SUBTREE_SELECTOR)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
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
      pendingGap = true;
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
    if (range.getClientRects().length === 0) continue;
    if (ranges.length >= MAX_MATCHES) return { ranges, truncated: true };
    ranges.push(range);
  }
  return { ranges, truncated: false };
}

const HIGHLIGHT_ALL = 'kimi-transcript-search';
const HIGHLIGHT_CURRENT = 'kimi-transcript-search-current';

type HighlightRegistryLike = { set(name: string, highlight: unknown): void; delete(name: string): void };
type HighlightInstanceLike = { add(range: Range): void };

function highlightsRegistry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  return css?.highlights ?? null;
}

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
