import type { BrowserHistoryEntry } from '../../shared/browser-data';
import { browserQueryTerms, findBrowserTextMatch, foldBrowserText, graphemeBrowserTextBoundary as charBoundary, type BrowserTextRange } from './browserTextHighlight';

export interface BrowserAddressSuggestionGroup {
  entry: BrowserHistoryEntry;
  urls: string[];
  titles: Map<string, string[]>;
  searches: { url: string; title: string; text: string }[];
}

export interface BrowserSuggestionClip {
  display: string;
  elisions: number[];
}

export interface BrowserAddressSuggestion {
  entry: BrowserHistoryEntry;
  url: string;
  title?: string;
}

const SUGGESTION_CHAR_WIDTH = 7;
const SUGGESTION_ROW_CHROME = 56;
const DIFFERENCE_MIN_VISIBLE = 12;
const DIFFERENCE_CONTEXT = 20;
const DIFFERENCE_FALLBACK_CONTEXT = 8;
const HEAD_SHARE = 0.4;
const MATCH_CONTEXT = 24;
const MATCH_TIGHT_CONTEXT = 8;
const URL_DELIMITERS = '/?&=#!,;+@:';

export function normalizeBrowserSuggestionUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = '';
  if (url.host === '') return url.href;
  const credentials = url.username === '' && url.password === '' ? '' : `${url.username}${url.password === '' ? '' : `:${url.password}`}@`;
  const path = url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${credentials}${url.host}${path}${url.search}`;
}

function foldSearchText(text: string): string {
  return foldBrowserText(text).trim().split(/\s+/).join(' ');
}

export function groupBrowserHistorySuggestions(history: readonly BrowserHistoryEntry[]): BrowserAddressSuggestionGroup[] {
  const groups = new Map<string, BrowserAddressSuggestionGroup>();
  for (const entry of history) {
    const key = normalizeBrowserSuggestionUrl(entry.url);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { entry, urls: [entry.url], titles: new Map(entry.title === '' ? [] : [[entry.url, [entry.title]]]), searches: [] });
      continue;
    }
    if (!group.urls.includes(entry.url)) group.urls.push(entry.url);
    if (entry.title !== '') {
      const titles = group.titles.get(entry.url) ?? [];
      if (!titles.includes(entry.title)) titles.push(entry.title);
      group.titles.set(entry.url, titles);
    }
    if (group.entry.title === '' && entry.title !== '') group.entry = { ...group.entry, title: entry.title };
    if (!group.entry.favicon && entry.favicon) group.entry = { ...group.entry, favicon: entry.favicon };
  }
  for (const group of groups.values()) {
    group.urls = [group.entry.url, ...group.urls.filter((url) => url !== group.entry.url)];
    group.searches = group.urls.flatMap((url) => {
      const titles = group.titles.get(url) ?? [];
      if (titles.length === 0) return [{ url, title: '', text: foldSearchText(url) }];
      return titles.map((title) => ({ url, title, text: `${foldSearchText(title)}\n${foldSearchText(url)}` }));
    });
  }
  return [...groups.values()];
}

function suggestionOf(group: BrowserAddressSuggestionGroup, index: number): BrowserAddressSuggestion {
  const { url, title } = group.searches[index]!;
  return title !== '' && title !== group.entry.title ? { entry: group.entry, url, title } : { entry: group.entry, url };
}

export function matchBrowserHistorySuggestions(groups: readonly BrowserAddressSuggestionGroup[], query: string, limit: number): BrowserAddressSuggestion[] {
  const phrase = foldSearchText(query).slice(0, 1024);
  const terms = browserQueryTerms(phrase);
  const phraseMatches: BrowserAddressSuggestion[] = [];
  const termMatches: BrowserAddressSuggestion[] = [];
  const phraseMatched = new Set<BrowserAddressSuggestionGroup>();
  for (const group of groups) {
    const phraseIndex = group.searches.findIndex((search) => search.text.includes(phrase));
    if (phraseIndex >= 0) {
      phraseMatches.push(suggestionOf(group, phraseIndex));
      phraseMatched.add(group);
      if (phraseMatches.length === limit) break;
    }
  }
  for (const group of groups) {
    if (phraseMatched.has(group)) continue;
    const termIndex = group.searches.findIndex((search) => terms.every((term) => search.text.includes(term)));
    if (termIndex >= 0) {
      termMatches.push(suggestionOf(group, termIndex));
      if (termMatches.length === limit) break;
    }
  }
  return [...phraseMatches, ...termMatches].slice(0, limit);
}

const WIDE_GLYPH = /[Wᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u;

function glyphColumns(text: string): number {
  let columns = 0;
  for (const char of text) columns += char.length > 1 || WIDE_GLYPH.test(char) ? 2 : char === 'M' ? 1.5 : 1;
  return columns;
}

function columnEnd(text: string, start: number, columns: number): number {
  let width = 0;
  let index = start;
  while (index < text.length) {
    const end = charBoundary(text, index + 1, 1);
    const next = width + glyphColumns(text.slice(index, end));
    if (next > columns) break;
    width = next;
    index = end;
  }
  return index;
}

export function browserSuggestionVisibleChars(width: number): number {
  return Math.max(1, Math.floor((width - SUGGESTION_ROW_CHROME) / SUGGESTION_CHAR_WIDTH));
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

function pathStart(url: string): number {
  const scheme = url.indexOf('://');
  if (scheme < 0) return -1;
  return url.indexOf('/', scheme + 3);
}

function collapseAt(url: string, path: number, tailStart: number, headLimit: number): { headEnd: number; tailStart: number } | null {
  const headEnd = Math.max(path, url.lastIndexOf('/', Math.min(tailStart, headLimit) - 1)) + 1;
  if (tailStart <= headEnd + 1) return null;
  return { headEnd, tailStart };
}

function boundaryBefore(url: string, index: number, floor: number, context: number): number {
  if (index - floor <= context) return floor;
  const from = index - context;
  const slash = url.lastIndexOf('/', index);
  if (slash >= from) return slash;
  for (let cursor = index; cursor >= from; cursor--) {
    if (URL_DELIMITERS.includes(url[cursor]!)) return cursor;
  }
  return index;
}

function boundaryAfter(url: string, index: number, ceiling: number, context: number): number {
  if (ceiling - index <= context) return ceiling;
  const to = index + context;
  const slash = url.indexOf('/', index);
  if (slash >= 0 && slash <= to) return slash;
  for (let cursor = index; cursor < to; cursor++) {
    if (URL_DELIMITERS.includes(url[cursor]!)) return cursor;
  }
  return index;
}

function composeCollapsed(url: string, headEnd: number, tailStart: number, matches: readonly BrowserTextRange[], context: number): string {
  let display = url.slice(0, headEnd);
  let cursor = headEnd;
  for (const match of matches) {
    if (match.end <= cursor) continue;
    if (match.start >= tailStart) break;
    const keepStart = Math.min(Math.max(cursor, match.start), boundaryBefore(url, match.start, cursor, context));
    const keepEnd = Math.max(Math.min(tailStart, match.end), boundaryAfter(url, match.end, tailStart, context));
    display += keepStart > cursor ? '…' : '';
    display += url.slice(keepStart, keepEnd);
    cursor = keepEnd;
  }
  return `${display}${cursor < tailStart ? '…' : ''}${url.slice(tailStart)}`;
}

function displayCollapsed(url: string, path: number, { headEnd, tailStart }: { headEnd: number; tailStart: number }, matches: readonly BrowserTextRange[], difference: number, visibleChars: number): { display: string; fits: boolean } {
  const differenceEnd = charBoundary(url, difference + 1, 1);
  let display = '';
  for (const [head, context] of [[headEnd, MATCH_CONTEXT], [headEnd, MATCH_TIGHT_CONTEXT], [path + 1, MATCH_TIGHT_CONTEXT]] as const) {
    display = composeCollapsed(url, head, tailStart, matches, context);
    if (glyphColumns(display) - glyphColumns(url.slice(differenceEnd)) <= visibleChars) return { display, fits: true };
  }
  return { display, fits: false };
}

export function collapseBrowserSuggestionUrl(url: string, shared: number, visibleChars: number, matches: readonly BrowserTextRange[] = [], forceDifference = false): string {
  if (glyphColumns(url) <= visibleChars || glyphColumns(url.slice(0, shared)) + DIFFERENCE_MIN_VISIBLE <= visibleChars) return url;
  let path = pathStart(url);
  if (path < 0) return url;
  if (shared <= path) {
    const scheme = url.indexOf('://');
    if (shared <= scheme + 2) return url;
    path = scheme + 2;
  }
  const anchor = charBoundary(url, Math.max(path, Math.min(shared, url.length - DIFFERENCE_MIN_VISIBLE)), -1);
  const floor = Math.max(path + 1, anchor - DIFFERENCE_CONTEXT);
  const difference = charBoundary(url, Math.min(shared, url.length - 1), -1);
  const candidates: number[] = [];
  if (!forceDifference) {
    const slash = url.lastIndexOf('/', anchor);
    if (slash >= floor) candidates.push(slash);
    for (let index = floor; index <= anchor; index++) {
      if (URL_DELIMITERS.includes(url[index]!)) candidates.push(index);
    }
    candidates.push(charBoundary(url, anchor - DIFFERENCE_FALLBACK_CONTEXT, -1), anchor);
  }
  candidates.push(difference);
  const differenceEnd = charBoundary(url, difference + 1, 1);
  const headLimit = Math.max(path + 1, Math.floor(visibleChars * HEAD_SHARE));
  let fallback: string | undefined;
  for (const tailStart of candidates) {
    const collapsed = collapseAt(url, path, tailStart, headLimit);
    if (collapsed === null) continue;
    if (glyphColumns(url.slice(0, collapsed.headEnd)) + 1 + glyphColumns(url.slice(tailStart, differenceEnd)) > visibleChars) continue;
    const { display, fits } = displayCollapsed(url, path, collapsed, matches, difference, visibleChars);
    if (fits) return display;
    fallback ??= display;
  }
  const minimal = collapseAt(url, path, anchor, path + 1);
  if (minimal !== null) {
    const { display, fits } = displayCollapsed(url, path, minimal, matches, difference, visibleChars);
    if (fits) return display;
    fallback ??= display;
  }
  return fallback ?? url;
}

function joinClipWindows(text: string, pins: readonly BrowserTextRange[], context: number, limit: number): BrowserSuggestionClip | null {
  let display = '';
  const elisions: number[] = [];
  let columns = 0;
  let cursor = 0;
  for (const pin of pins) {
    if (pin.end <= cursor) continue;
    const start = Math.max(cursor, charBoundary(text, pin.start - context, 1));
    const end = Math.min(text.length, charBoundary(text, pin.end + context, -1));
    const separator = start > cursor ? 1 : 0;
    const added = separator + glyphColumns(text.slice(start, end));
    if (columns + added > limit) return null;
    if (separator === 1) { elisions.push(display.length); display += '…'; }
    display += text.slice(start, end);
    columns += added;
    cursor = end;
  }
  if (cursor < text.length) {
    if (columns + 1 > limit) return null;
    const end = Math.min(text.length, columnEnd(text, cursor, limit - columns - 1));
    display += text.slice(cursor, end);
    cursor = end;
    if (cursor < text.length) { elisions.push(display.length); display += '…'; }
  }
  return { display, elisions };
}

function clipHead(text: string, limit: number, unitCap: number): string {
  const head = text.slice(0, columnEnd(text, 0, limit));
  if (head !== '') return head;
  const fallback = text.slice(0, charBoundary(text, 1, 1));
  return fallback.length <= unitCap ? fallback : fallback.slice(0, unitCap);
}

function clipSpan(text: string, limit: number, from: number, hitEnd: number): BrowserSuggestionClip | null {
  const marker = from === 0 ? '' : '…';
  const tail = hitEnd < text.length ? 1 : 0;
  if (glyphColumns(text.slice(from, hitEnd)) + marker.length + tail > limit) return null;
  const budget = limit - marker.length;
  const end = Math.max(hitEnd, columnEnd(text, from, budget - 1));
  const body = text.slice(from, end);
  return clipWindow(marker, body, glyphColumns(body) < budget && end < text.length);
}

function clipToFirstHit(text: string, limit: number, anchorPin: BrowserTextRange, matches: readonly BrowserTextRange[]): BrowserSuggestionClip | null {
  const hit = matches.find((match) => match.start >= anchorPin.end);
  if (hit === undefined) return null;
  const anchorStart = charBoundary(text, anchorPin.end - 1, -1);
  const hitEnd = charBoundary(text, hit.end, 1);
  const pins = [{ start: anchorStart, end: anchorPin.end }, ...matches].sort((a, b) => a.start - b.start);
  return clipSpan(text, limit, anchorStart, hitEnd) ?? joinClipWindows(text, pins, 0, limit) ?? clipSpan(text, limit, charBoundary(text, hit.start, -1), hitEnd);
}

function clipWindow(head: string, body: string, tail: boolean): BrowserSuggestionClip {
  const elisions: number[] = [];
  if (head !== '') elisions.push(0);
  if (tail) elisions.push(head.length + body.length);
  return { display: `${head}${body}${tail ? '…' : ''}`, elisions };
}

export function clipBrowserSuggestionDisplay(text: string, limit: number, query: string, anchor?: number, unitCap = 256): BrowserSuggestionClip {
  if (glyphColumns(text) <= limit) return { display: text, elisions: [] };
  const matches = firstTermMatches(text, query);
  const fitsHead = (range: BrowserTextRange): boolean => glyphColumns(text.slice(0, range.end)) <= limit;
  const anchorPin = anchor === undefined || matches.some((match) => match.start <= anchor && match.end > anchor) ? undefined : fitsHead({ start: 0, end: charBoundary(text, anchor + 1, 1) }) ? { start: 0, end: charBoundary(text, anchor + 1, 1) } : { start: charBoundary(text, Math.max(0, anchor - MATCH_TIGHT_CONTEXT), 1), end: charBoundary(text, anchor + 1, 1) };
  const pins = (anchorPin === undefined ? matches : [anchorPin, ...matches]).sort((a, b) => a.start - b.start);
  if ((anchorPin === undefined || fitsHead(anchorPin)) && matches.every((match) => fitsHead(match))) return { display: clipHead(text, limit, unitCap), elisions: [] };
  for (const context of [MATCH_CONTEXT, MATCH_TIGHT_CONTEXT, 0]) {
    const clip = joinClipWindows(text, pins, context, limit);
    if (clip !== null) return clip;
  }
  if (pins.length === 0) return { display: clipHead(text, limit, unitCap), elisions: [] };
  const first = pins[0]!;
  if (anchorPin !== undefined && first === anchorPin) {
    const hitWindow = clipToFirstHit(text, limit, anchorPin, matches);
    if (hitWindow !== null) return hitWindow;
  }
  const pinEnd = charBoundary(text, first.end, 1);
  let start = charBoundary(text, Math.max(0, first.start - MATCH_CONTEXT), 1);
  if (first.end - first.start <= limit && glyphColumns(text.slice(start, pinEnd)) > limit) start = charBoundary(text, pinEnd - limit, -1);
  const span = glyphColumns(text.slice(start, pinEnd));
  if (start > 0 && span <= limit && span > limit - 1) start = Math.max(start, charBoundary(text, first.start, -1));
  const pinned = glyphColumns(text.slice(start, pinEnd));
  if (pinned <= limit) {
    const marker = start === 0 || pinned > limit - 1 ? '' : '…';
    const budget = limit - marker.length;
    const end = Math.max(pinEnd, columnEnd(text, start, budget - 1));
    const body = text.slice(start, end);
    return clipWindow(marker, body, glyphColumns(body) < budget && end < text.length);
  }
  const reserve = start === 0 ? 1 : 2;
  const end = columnEnd(text, start, limit - reserve);
  return clipWindow(start === 0 ? '' : '…', text.slice(start, end), end < text.length);
}

export function clipBrowserSuggestionText(text: string, limit: number, query: string, anchor?: number, unitCap = 256): string {
  return clipBrowserSuggestionDisplay(text, limit, query, anchor, unitCap).display;
}

function firstTermMatches(text: string, query: string): BrowserTextRange[] {
  const matches: BrowserTextRange[] = [];
  for (const term of browserQueryTerms(foldBrowserText(query))) {
    const match = findBrowserTextMatch(text, term);
    if (match !== undefined) matches.push({ start: charBoundary(text, match.start, -1), end: charBoundary(text, match.end, 1) });
  }
  return matches.sort((a, b) => a.start - b.start);
}

export function browserSuggestionDisplayDifference(displays: readonly string[], index: number): number | undefined {
  if (displays.length < 2) return undefined;
  const display = displays[index]!;
  let shared = 0;
  for (const [otherIndex, other] of displays.entries()) {
    if (otherIndex !== index) shared = Math.max(shared, commonPrefixLength(display, other));
  }
  return shared < display.length ? shared : undefined;
}

export function distinguishBrowserSuggestionUrls(urls: readonly string[], visibleChars: number, query = ''): string[] {
  const shared = urls.map((url, index) => {
    let longest = 0;
    for (const [otherIndex, other] of urls.entries()) {
      if (otherIndex !== index) longest = Math.max(longest, commonPrefixLength(url, other));
    }
    return longest;
  });
  const matches = urls.map((url) => firstTermMatches(url, query));
  const displays = urls.map((url, index) => collapseBrowserSuggestionUrl(url, shared[index]!, visibleChars, matches[index]!));
  for (let pass = 0; pass < urls.length; pass++) {
    const groups = new Map<string, number[]>();
    for (const [index, display] of displays.entries()) {
      const group = groups.get(display);
      if (group === undefined) groups.set(display, [index]);
      else group.push(index);
    }
    let progressed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const index of group) {
        let pairwise = shared[index]!;
        for (const other of group) {
          if (other !== index) pairwise = Math.min(pairwise, commonPrefixLength(urls[index]!, urls[other]!));
        }
        const forced = collapseBrowserSuggestionUrl(urls[index]!, pairwise, visibleChars, matches[index]!, true);
        if (forced !== displays[index]) { displays[index] = forced; progressed = true; }
      }
    }
    if (!progressed) return displays;
  }
  return displays;
}
