import { describe, expect, it, vi } from 'vitest';
import {
  browserSuggestionDisplayDifference,
  browserSuggestionVisibleChars,
  clipBrowserSuggestionText,
  collapseBrowserSuggestionUrl,
  distinguishBrowserSuggestionUrls,
  groupBrowserHistorySuggestions,
  matchBrowserHistorySuggestions,
  normalizeBrowserSuggestionUrl,
} from '../../src/renderer/lib/browserAddressSuggestions';
import { findBrowserCommonRange, findBrowserTextMatches, foldBrowserText, splitBrowserTextHighlights } from '../../src/renderer/lib/browserTextHighlight';

const DIR = 'https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR/St.+Louis,+MO+63105,+USA';
const DATA = 'data=!3m1!4b1!4m14!4m13!1m5!1m1!1s0x54c11e3d8e4f0a6b:0x3a1f1c1b2a9e8d7c!2m2!1d-123.0726055!2d44.0448302!1m5!1m1!1s0x87d8cb2f3b6a5c01:0x2f5b8b0a1e3c4d5e!2m2!1d-90.3371889!2d38.6425518';
const MAPS = [
  `${DIR}/@41.3717265,-111.3170312,5z/${DATA}!3e0?entry=ttu`,
  `${DIR}/@40.9125081,-106.2944017,4z/${DATA}!3e0?entry=ttu`,
  `${DIR}/@41.3717265,-111.3170312,5z/${DATA}!3e2?entry=ttu`,
  `${DIR}/@41.3717265,-111.3170312,5z/${DATA}!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNi4wIKXMDSoASAFQAw%3D%3D`,
];
const TITLE = 'University of Oregon to St. Louis, MO 63105, USA - Google Maps';

describe('address suggestion highlights', () => {
  it('finds every case-insensitive occurrence of the query', () => {
    expect(findBrowserTextMatches(TITLE, 'oregon')).toEqual([{ start: 14, end: 20 }]);
    expect(findBrowserTextMatches(MAPS[0]!, 'OREGON')).toEqual([{ start: 46, end: 52 }]);
    expect(findBrowserTextMatches('Oregon oregon OREGON', 'oregon')).toEqual([{ start: 0, end: 6 }, { start: 7, end: 13 }, { start: 14, end: 20 }]);
  });

  it('highlights each word of a multi-word query and merges overlaps', () => {
    expect(findBrowserTextMatches(TITLE, '  oregon   louis ')).toEqual([{ start: 14, end: 20 }, { start: 28, end: 33 }]);
    expect(findBrowserTextMatches('Oregon', 'ore gon oregon')).toEqual([{ start: 0, end: 6 }]);
    expect(findBrowserTextMatches('a.b(c)', '.b( c)')).toEqual([{ start: 1, end: 6 }]);
    expect(findBrowserTextMatches(TITLE, '   ')).toEqual([]);
    expect(findBrowserTextMatches(TITLE, 'seattle')).toEqual([]);
  });

  it('highlights every word even when another word matches many times', () => {
    expect(findBrowserTextMatches('a'.repeat(200), 'a')).toEqual([{ start: 0, end: 200 }]);
    expect(findBrowserTextMatches('ab'.repeat(200), 'a')).toHaveLength(200);
    const text = `${'a_'.repeat(70)}oregon`;
    const ranges = findBrowserTextMatches(text, 'a oregon');
    expect(ranges).toHaveLength(71);
    expect(ranges.at(-1)).toEqual({ start: 140, end: 146 });
  });

  it('highlights overlapping occurrences of a query word', () => {
    expect(findBrowserTextMatches('aaa', 'aa')).toEqual([{ start: 0, end: 3 }]);
    expect(findBrowserTextMatches('ababab', 'abab')).toEqual([{ start: 0, end: 6 }]);
    expect(findBrowserTextMatches('aAaA', 'aa')).toEqual([{ start: 0, end: 4 }]);
  });

  it('folds case the same way for matching, emphasis and clipping', () => {
    expect(findBrowserTextMatches('İstanbul', 'i')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('İstanbul', 'İST')).toEqual([{ start: 0, end: 3 }]);
    expect(findBrowserTextMatches('🙂 Oregon', 'oregon')).toEqual([{ start: 3, end: 9 }]);
    const entry = { id: 'tr', url: 'https://example.com/tr', title: `${'x'.repeat(300)} İzmir`, visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'i', 8).map((match) => match.entry)).toEqual([entry]);
    const clipped = clipBrowserSuggestionText(entry.title, 256, 'i');
    expect(clipped).toContain('İzmir');
    const [range] = findBrowserTextMatches(clipped, 'i');
    expect(clipped.slice(range!.start, range!.end)).toBe('İ');
  });

  it('folds case with whole-string context so a final sigma matches', () => {
    expect(findBrowserTextMatches('ΟΔΟΣ Athens', 'οδος')).toEqual([{ start: 0, end: 4 }]);
    expect(findBrowserTextMatches('οδος', 'ΟΔΟΣ')).toEqual([{ start: 0, end: 4 }]);
    expect(findBrowserTextMatches('ΟΔΟΣ Athens', 'οδοσ')).toEqual([{ start: 0, end: 4 }]);
    const entry = { id: 'gr', url: 'https://example.com/gr', title: 'ΟΔΟΣ', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'οδος', 8).map((match) => match.entry)).toEqual([entry]);
  });

  it('folds sigmas to one form so a single sigma matches anywhere', () => {
    expect(findBrowserTextMatches('ΟΔΟΣ', 'σ')).toEqual([{ start: 3, end: 4 }]);
    expect(findBrowserTextMatches('ΟΔΟΣ', 'ς')).toEqual([{ start: 3, end: 4 }]);
    expect(findBrowserTextMatches('Σήμα', 'σ')).toEqual([{ start: 0, end: 1 }]);
    const entry = { id: 'gr', url: 'https://example.com/gr', title: 'ΟΔΟΣ', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'σ', 8).map((match) => match.entry)).toEqual([entry]);
  });

  it('folds precomposed characters to their canonical base sequences', () => {
    expect(findBrowserTextMatches('ǰ', 'ǰ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ΐ', 'ΐ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ΰ', 'ΰ')).toEqual([{ start: 0, end: 1 }]);
    for (const text of ['ǰ', 'ΐ', 'ΰ', 'ß', 'ﬀ', 'ΟΔΟΣ', 'İstanbul']) {
      expect(foldBrowserText(foldBrowserText(text))).toBe(foldBrowserText(text));
    }
  });

  it('folds the full simple case folding set including Cyrillic extended-C', () => {
    expect(findBrowserTextMatches('ᲀ', 'в')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ᲈ', 'ꙋ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ᏸ', 'Ᏸ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('꭬', 'ꭋ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('꟝', 'ɷ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('𝾕', 'ss')).toEqual([{ start: 0, end: 2 }]);
    const entry = { id: 'cy', url: 'https://example.com/cy', title: 'ᲀᲁᲂ', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'вдо', 8).map((match) => match.entry)).toEqual([entry]);
  });

  it('folds the complete one-to-one caseless equivalents', () => {
    expect(findBrowserTextMatches('ϐ', 'β')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ϑ', 'θ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ϕ', 'φ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ϰ', 'κ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ϱ', 'ρ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ϵ', 'ε')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ẛ', 'ṡ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('ι', 'ι')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('straße', 'STRASSE')).toEqual([{ start: 0, end: 6 }]);
    expect(findBrowserTextMatches('ﬀ', 'ff')).toEqual([{ start: 0, end: 1 }]);
    const entry = { id: 'b', url: 'https://example.com/b', title: 'ϐητα', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'βητα', 8).map((match) => match.entry)).toEqual([entry]);
  });

  it('folds simple caseless equivalents that lowercasing misses', () => {
    expect(findBrowserTextMatches('ſite', 'site')).toEqual([{ start: 0, end: 4 }]);
    expect(findBrowserTextMatches('SITE', 'ſ')).toEqual([{ start: 0, end: 1 }]);
    expect(findBrowserTextMatches('µs', 'ΜS')).toEqual([{ start: 0, end: 2 }]);
    const entry = { id: 'ls', url: 'https://example.com/ls', title: 'ſite', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([entry]);
    expect(matchBrowserHistorySuggestions(groups, 'site', 8).map((match) => match.entry)).toEqual([entry]);
  });

  it('expands highlight ranges to whole grapheme clusters', () => {
    expect(findBrowserTextMatches('👨‍👩‍👧', '👩')).toEqual([{ start: 0, end: 8 }]);
    expect(findBrowserTextMatches('👨‍👩‍👧', '👨‍👩‍👧')).toEqual([{ start: 0, end: 8 }]);
    expect(findBrowserTextMatches('xe\u0301y', 'e')).toEqual([{ start: 1, end: 3 }]);
    expect(findBrowserTextMatches('xe\u0301y', 'x')).toEqual([{ start: 0, end: 1 }]);
  });

  it('finds the longest common range between a fragment and the query', () => {
    expect(findBrowserCommonRange(`prefix${'a'.repeat(42)}`, 'a'.repeat(60))).toEqual({ start: 6, end: 48 });
    expect(findBrowserCommonRange('https://example.com/aaaa', `https://example.com/${'a'.repeat(100)}`)).toEqual({ start: 0, end: 24 });
    expect(findBrowserCommonRange('Git', 'github')).toEqual({ start: 0, end: 3 });
    expect(findBrowserCommonRange('e\u0301', '\u0301')).toEqual({ start: 0, end: 2 });
    expect(findBrowserCommonRange('👨‍👩‍👧', '👩')).toEqual({ start: 0, end: 8 });
    expect(findBrowserCommonRange('xyz', 'github')).toBeUndefined();
  });

  it('splits text into plain and matched segments', () => {
    expect(splitBrowserTextHighlights(TITLE, [{ start: 14, end: 20 }])).toEqual([
      { text: 'University of ', match: false },
      { text: 'Oregon', match: true },
      { text: ' to St. Louis, MO 63105, USA - Google Maps', match: false },
    ]);
    expect(splitBrowserTextHighlights('Oregon', [{ start: 0, end: 6 }])).toEqual([{ text: 'Oregon', match: true }]);
    expect(splitBrowserTextHighlights('Oregon', undefined)).toEqual([{ text: 'Oregon', match: false }]);
    expect(splitBrowserTextHighlights('', [])).toEqual([{ text: '', match: false }]);
    expect(splitBrowserTextHighlights('abcdef', [{ start: 2, end: 4 }, { start: 3, end: 5 }, { start: 5, end: 9 }])).toEqual([
      { text: 'ab', match: false }, { text: 'cd', match: true }, { text: 'ef', match: false },
    ]);
  });
});

describe('address suggestion dedupe', () => {
  it('normalizes the scheme and host case, default port, trailing slash and fragment', () => {
    const key = normalizeBrowserSuggestionUrl('https://www.google.com/maps');
    for (const variant of ['HTTPS://WWW.Google.com/maps', 'https://www.google.com:443/maps', 'https://www.google.com/maps/', 'https://www.google.com/maps#section']) {
      expect(normalizeBrowserSuggestionUrl(variant)).toBe(key);
    }
    expect(normalizeBrowserSuggestionUrl('https://example.com/')).toBe(normalizeBrowserSuggestionUrl('https://example.com'));
    expect(normalizeBrowserSuggestionUrl('https://example.com/Maps')).not.toBe(normalizeBrowserSuggestionUrl('https://example.com/maps'));
    expect(normalizeBrowserSuggestionUrl('https://example.com/?q=1')).not.toBe(normalizeBrowserSuggestionUrl('https://example.com/?q=2'));
    expect(normalizeBrowserSuggestionUrl('http://example.com/')).not.toBe(normalizeBrowserSuggestionUrl('https://example.com/'));
    expect(normalizeBrowserSuggestionUrl('http://example.com:8080/')).not.toBe(normalizeBrowserSuggestionUrl('http://example.com/'));
    expect(normalizeBrowserSuggestionUrl('about:blank#x')).toBe('about:blank');
    expect(normalizeBrowserSuggestionUrl('not a url')).toBe('not a url');
  });

  it('searches every merged title and returns the record that matched', () => {
    const overview = { id: 'a', url: 'https://example.com/page#overview', title: 'Overview', visitedAt: 2 };
    const install = { id: 'b', url: 'https://example.com/page#install', title: 'Installation Guide', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([overview, install]);
    expect(matchBrowserHistorySuggestions(groups, 'installation', 8)).toEqual([{ entry: overview, url: install.url, title: 'Installation Guide' }]);
    expect(matchBrowserHistorySuggestions(groups, 'overview', 8)).toEqual([{ entry: overview, url: overview.url }]);
    const single = { id: 'c', url: 'https://example.com/other', title: '', visitedAt: 3 };
    const merged = groupBrowserHistorySuggestions([single, install, overview]);
    expect(merged.map((group) => group.titles)).toEqual([new Map(), new Map([[install.url, ['Installation Guide']], [overview.url, ['Overview']]])]);
  });

  it('does not match a query across two different titles of one URL', () => {
    const alpha = { id: 'a', url: 'https://example.com/page', title: 'alpha', visitedAt: 2 };
    const beta = { id: 'b', url: 'https://example.com/page', title: 'beta', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([alpha, beta]);
    expect(matchBrowserHistorySuggestions(groups, 'alpha beta', 8)).toEqual([]);
    expect(matchBrowserHistorySuggestions(groups, 'alpha', 8).map((match) => match.url)).toEqual([alpha.url]);
    expect(matchBrowserHistorySuggestions(groups, 'beta', 8).map((match) => match.url)).toEqual([beta.url]);
  });

  it('returns the matched title when one URL has several titled records', () => {
    const overview = { id: 'a', url: 'https://example.com/page', title: 'Overview', visitedAt: 2 };
    const install = { id: 'b', url: 'https://example.com/page', title: 'Installation Guide', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([overview, install]);
    expect(matchBrowserHistorySuggestions(groups, 'installation', 8)).toEqual([{ entry: overview, url: overview.url, title: 'Installation Guide' }]);
    expect(matchBrowserHistorySuggestions(groups, 'overview', 8)).toEqual([{ entry: overview, url: overview.url }]);
  });

  it('borrows the first non-empty title from a duplicate like the favicon', () => {
    const untitled = { id: 'a', url: 'https://example.com/page#top', title: '', visitedAt: 2 };
    const titled = { id: 'b', url: 'https://example.com/page', title: 'Documentation', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([untitled, titled]);
    expect(groups[0]!.entry).toEqual({ ...untitled, title: titled.title });
    expect(matchBrowserHistorySuggestions(groups, 'documentation', 8).map((match) => match.url)).toEqual([titled.url]);
    expect(matchBrowserHistorySuggestions(groups, '', 8).map((match) => match.url)).toEqual([untitled.url]);
  });

  it('merges only a single trailing slash, keeping repeated trailing slashes distinct', () => {
    expect(normalizeBrowserSuggestionUrl('https://example.com/api/')).toBe(normalizeBrowserSuggestionUrl('https://example.com/api'));
    expect(normalizeBrowserSuggestionUrl('https://example.com/api//')).not.toBe(normalizeBrowserSuggestionUrl('https://example.com/api'));
    const plain = { id: 'a', url: 'https://example.com/api', title: 'API', visitedAt: 3 };
    const slash = { id: 'b', url: 'https://example.com/api/', title: 'API', visitedAt: 2 };
    const double = { id: 'c', url: 'https://example.com/api//', title: 'API', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([plain, slash, double]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.urls).toEqual([plain.url, slash.url]);
    expect(groups[1]!.urls).toEqual([double.url]);
  });

  it('keeps the newest record and borrows only the favicon from a duplicate', () => {
    const clock = { id: 'a', url: `${MAPS[0]}#x`, title: TITLE, visitedAt: 4 };
    const other = { id: 'b', url: MAPS[1]!, title: TITLE, visitedAt: 3 };
    const favicon = { id: 'c', url: MAPS[0]!, title: 'Old title', favicon: 'https://www.google.com/favicon.ico', visitedAt: 2 };
    const later = { id: 'd', url: MAPS[0]!.replace('https://www.google.com', 'https://WWW.GOOGLE.COM:443'), title: TITLE, favicon: 'https://www.google.com/other.ico', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([clock, other, favicon, later]);
    expect(groups[0]!.entry).toEqual({ ...clock, favicon: favicon.favicon });
    expect(groups[0]!.urls).toEqual([clock.url, favicon.url, later.url]);
    expect(groups[1]!.entry).toEqual(other);
    expect(matchBrowserHistorySuggestions(groups, '', 8).map((match) => match.url)).toEqual([clock.url, other.url]);
  });

  it('keeps the first entry when no duplicate has a favicon', () => {
    const first = { id: 'a', url: 'https://example.com/', title: 'Example', visitedAt: 2 };
    const second = { id: 'b', url: 'https://example.com', title: 'Example', visitedAt: 1 };
    expect(groupBrowserHistorySuggestions([first, second]).map((group) => group.entry)).toEqual([first]);
  });
});

describe('address suggestion matching', () => {
  const docs = { id: 'docs', url: 'https://example.com/docs', title: 'Reference', visitedAt: 5 };
  const words = { id: 'words', url: 'https://example.com/blog', title: 'Release notes and docs', visitedAt: 4 };
  const phrase = { id: 'phrase', url: 'https://example.com/guide', title: 'Example docs home', visitedAt: 3 };
  const oregon = { id: 'oregon', url: MAPS[0]!, title: TITLE, visitedAt: 2 };
  const groups = groupBrowserHistorySuggestions([docs, words, phrase, oregon]);

  it('requires every query word in the title or a URL, case-insensitively', () => {
    expect(matchBrowserHistorySuggestions(groups, 'example docs', 8).map((match) => match.entry)).toEqual([phrase, docs, words]);
    expect(matchBrowserHistorySuggestions(groups, 'EXAMPLE   Docs', 8).map((match) => match.entry)).toEqual([phrase, docs, words]);
    expect(matchBrowserHistorySuggestions(groups, 'oregon louis', 8).map((match) => match.entry)).toEqual([oregon]);
    expect(matchBrowserHistorySuggestions(groups, 'st. louis google', 8).map((match) => match.entry)).toEqual([oregon]);
    expect(matchBrowserHistorySuggestions(groups, 'example seattle', 8).map((match) => match.entry)).toEqual([]);
  });

  it('ranks whole-phrase matches first and keeps history order within each rank', () => {
    expect(matchBrowserHistorySuggestions(groups, 'example.com/', 8).map((match) => match.entry)).toEqual([docs, words, phrase]);
    expect(matchBrowserHistorySuggestions(groups, 'docs example', 8).map((match) => match.entry)).toEqual([docs, words, phrase]);
    expect(matchBrowserHistorySuggestions(groups, '', 8).map((match) => match.entry)).toEqual([docs, words, phrase, oregon]);
    expect(matchBrowserHistorySuggestions(groups, 'example docs', 2).map((match) => match.entry)).toEqual([phrase, docs]);
  });

  it('ranks a full-phrase match first even when the title has irregular whitespace', () => {
    const newer = { id: 'a', url: 'https://example.com/a', title: 'foo baz bar', visitedAt: 3 };
    const spaced = { id: 'b', url: 'https://example.com/b', title: 'Foo   bar', visitedAt: 2 };
    const newline = { id: 'c', url: 'https://example.com/c', title: 'foo\nbar baz', visitedAt: 1 };
    const groups = groupBrowserHistorySuggestions([newer, spaced, newline]);
    expect(matchBrowserHistorySuggestions(groups, 'foo bar', 8).map((match) => match.entry)).toEqual([spaced, newline, newer]);
  });

  it('keeps repeated words in the whole phrase used for ranking', () => {
    const single = { id: 'single', url: 'https://foo.test/bar', title: 'foo bar', visitedAt: 2 };
    const repeated = { id: 'repeated', url: 'https://foo.test/foo-foo', title: 'foo foo', visitedAt: 1 };
    const ranked = groupBrowserHistorySuggestions([single, repeated]);
    expect(matchBrowserHistorySuggestions(ranked, 'foo foo', 8).map((match) => match.entry)).toEqual([repeated, single]);
    expect(matchBrowserHistorySuggestions(ranked, '  FOO   foo ', 8).map((match) => match.entry)).toEqual([repeated, single]);
    expect(matchBrowserHistorySuggestions(ranked, 'foo', 8).map((match) => match.entry)).toEqual([single, repeated]);
  });

  it('bounds the filter query and stops collecting term matches at the limit', () => {
    const history = Array.from({ length: 200 }, (_, index) => ({ id: `h${index}`, url: `https://example.com/${index}`, title: `match ${index}`, visitedAt: 1000 - index }));
    const groups = groupBrowserHistorySuggestions(history);
    const words = Array.from({ length: 3375 }, (_, index) => `w${index.toString(36)}`).join(' ');
    const matched = matchBrowserHistorySuggestions(groups, 'match', 8);
    expect(matched).toHaveLength(8);
    expect(matched[0]!.url).toBe('https://example.com/0');
    expect(matchBrowserHistorySuggestions(groups, words, 8)).toHaveLength(0);
    expect(matchBrowserHistorySuggestions(groups, `match ${'a '.repeat(3000)}zzz`, 8)).toHaveLength(8);
  });

  it('folds ASCII history text in one pass per string when grouping', () => {
    const history = Array.from({ length: 200 }, (_, index) => ({ id: `h${index}`, url: `https://Example.com/${index}/${'Ab%2F'.repeat(1000)}`, title: `Page ${index}`, visitedAt: 1000 - index }));
    const lower = vi.spyOn(String.prototype, 'toLowerCase');
    let groups: ReturnType<typeof groupBrowserHistorySuggestions>;
    try {
      groups = groupBrowserHistorySuggestions(history);
      expect(lower.mock.calls.length).toBeLessThanOrEqual(history.length * 2);
    } finally {
      lower.mockRestore();
    }
    expect(groups[0]!.searches[0]!.text).toBe(`page 0\nhttps://example.com/0/${'ab%2f'.repeat(1000)}`);
    expect(matchBrowserHistorySuggestions(groups, 'EXAMPLE.COM/199/aB', 8).map((match) => match.entry.id)).toEqual(['h199']);
    expect(foldBrowserText('HTTPS://E.CO/Straße/ΣΑΣ')).toBe('https://e.co/strasse/σασ');
  });

  it('shows the merged URL that matched when the kept URL does not', () => {
    const kept = { id: 'a', url: 'https://example.com/page', title: 'Page', visitedAt: 2 };
    const variant = { id: 'b', url: 'https://example.com/page#install', title: 'Page', favicon: 'https://example.com/favicon.ico', visitedAt: 1 };
    const merged = groupBrowserHistorySuggestions([kept, variant]);
    const entry = { ...kept, favicon: variant.favicon };
    expect(merged.map((group) => group.entry)).toEqual([entry]);
    expect(matchBrowserHistorySuggestions(merged, 'install', 8)).toEqual([{ entry, url: variant.url }]);
    expect(matchBrowserHistorySuggestions(merged, 'page install', 8)).toEqual([{ entry, url: variant.url }]);
    expect(matchBrowserHistorySuggestions(merged, 'example page', 8)).toEqual([{ entry, url: kept.url }]);
    expect(matchBrowserHistorySuggestions(merged, '', 8)).toEqual([{ entry, url: kept.url }]);
  });
});

describe('address suggestion difference display', () => {
  it('estimates how many URL characters fit in a row', () => {
    expect(browserSuggestionVisibleChars(400)).toBe(49);
    expect(browserSuggestionVisibleChars(180)).toBe(17);
    expect(browserSuggestionVisibleChars(100)).toBe(6);
  });

  it('collapses the shared middle of lookalike Google Maps URLs so the differing tail stays visible', () => {
    const visible = browserSuggestionVisibleChars(760);
    const displays = distinguishBrowserSuggestionUrls(MAPS, visible);
    expect(displays).toEqual([
      'https://www.google.com/maps/dir/…!2d38.6425518!3e0?entry=ttu',
      `https://www.google.com/maps/dir/…/@40.9125081,-106.2944017,4z/${DATA}!3e0?entry=ttu`,
      'https://www.google.com/maps/dir/…!2d38.6425518!3e2?entry=ttu',
      'https://www.google.com/maps/dir/…!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNi4wIKXMDSoASAFQAw%3D%3D',
    ]);
    for (const [index, display] of displays.entries()) {
      const tail = display.slice(display.indexOf('…') + 1);
      expect(MAPS[index]!.endsWith(tail)).toBe(true);
    }
    expect(new Set(displays.map((display) => display.slice(0, visible))).size).toBe(MAPS.length);
    expect(new Set(MAPS.map((url) => url.slice(0, visible))).size).toBe(2);
  });

  it('puts the ellipsis right after the host when the row is narrow', () => {
    const visible = browserSuggestionVisibleChars(400);
    expect(new Set(MAPS.map((url) => url.slice(0, visible))).size).toBe(1);
    expect(distinguishBrowserSuggestionUrls(MAPS, visible).map((display) => display.slice(0, visible))).toEqual([
      'https://www.google.com/…!3e0?entry=ttu',
      'https://www.google.com/…/@40.9125081,-106.2944017',
      'https://www.google.com/…!2d38.6425518!3e2?entry=t',
      'https://www.google.com/…!3e0?entry=ttu&g_ep=EgoyM',
    ]);
  });

  it('falls back past the root slash when the first path segment holds the difference', () => {
    const urls = ['https://example.com/abcdXsegment-that-keeps-going-for-a-while?x=1', 'https://example.com/abcdYsegment-that-keeps-going-for-a-while?x=1'];
    expect(distinguishBrowserSuggestionUrls(urls, 24)).toEqual(['https://example.com/…Xsegment-that-keeps-going-for-a-while?x=1', 'https://example.com/…Ysegment-that-keeps-going-for-a-while?x=1']);
    const places = ['https://example.com/University+of+Oregon+Knight+Library,+Eugene', 'https://example.com/University+of+Oregon+Museum+of+Art,+Eugene'];
    expect(distinguishBrowserSuggestionUrls(places, 24)).toEqual(['https://example.com/…+Knight+Library,+Eugene', 'https://example.com/…+Museum+of+Art,+Eugene']);
    expect(distinguishBrowserSuggestionUrls(places, 30)).toEqual(['https://example.com/…+Oregon+Knight+Library,+Eugene', 'https://example.com/…+Museum+of+Art,+Eugene']);
    for (const [set, widths] of [[urls, [24, 30, 40, 49, 100]], [places, [24, 30, 40, 49, 100]], [MAPS, [30, 40, 49, 100]]] as const) {
      for (const visible of widths) {
        const displays = distinguishBrowserSuggestionUrls(set, visible);
        expect(new Set(displays.map((display) => display.slice(0, visible))).size).toBe(set.length);
        for (const [index, display] of displays.entries()) {
          if (display === set[index]) continue;
          expect(set[index]!.startsWith(display.slice(0, display.indexOf('…')))).toBe(true);
          expect(set[index]!.endsWith(display.slice(display.indexOf('…') + 1))).toBe(true);
        }
      }
    }
  });

  it('never collapses the shared segment that holds the first match', () => {
    expect(distinguishBrowserSuggestionUrls(MAPS, browserSuggestionVisibleChars(400)).some((display) => /oregon/i.test(display))).toBe(false);
    expect(distinguishBrowserSuggestionUrls(MAPS, browserSuggestionVisibleChars(400), 'oregon')).toEqual([
      'https://www.google.com/…+Oregon…!3e0?entry=ttu',
      `https://www.google.com/…+Oregon…/@40.9125081,-106.2944017,4z/${DATA}!3e0?entry=ttu`,
      'https://www.google.com/…+Oregon…!2d38.6425518!3e2?entry=ttu',
      'https://www.google.com/…+Oregon…!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNi4wIKXMDSoASAFQAw%3D%3D',
    ]);
    expect(distinguishBrowserSuggestionUrls(MAPS, browserSuggestionVisibleChars(760), 'oregon')).toEqual([
      'https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR…!2d38.6425518!3e0?entry=ttu',
      `https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR…/@40.9125081,-106.2944017,4z/${DATA}!3e0?entry=ttu`,
      'https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR…!2d38.6425518!3e2?entry=ttu',
      'https://www.google.com/maps/dir/University+of+Oregon,+Eugene,+OR…!3e0?entry=ttu&g_ep=EgoyMDI2MDkxNi4wIKXMDSoASAFQAw%3D%3D',
    ]);
    for (const visible of [49, 100]) {
      const displays = distinguishBrowserSuggestionUrls(MAPS, visible, 'oregon');
      expect(new Set(displays.map((display) => display.slice(0, visible))).size).toBe(MAPS.length);
      for (const [index, display] of displays.entries()) {
        expect(display.slice(0, visible)).toMatch(/Oregon/);
        expect(MAPS[index]!.endsWith(display.slice(display.lastIndexOf('…') + 1))).toBe(true);
      }
    }
    for (const display of distinguishBrowserSuggestionUrls(MAPS, 30, 'oregon')) expect(display.slice(0, 30)).toContain('Orego');
    expect(distinguishBrowserSuggestionUrls(MAPS, 100, 'google')).toEqual(distinguishBrowserSuggestionUrls(MAPS, 100));
    expect(distinguishBrowserSuggestionUrls(MAPS, 100, '3e2')).toEqual(distinguishBrowserSuggestionUrls(MAPS, 100));
  });

  it('distinguishes URLs that differ inside a long host', () => {
    const urls = [`https://${'a'.repeat(55)}x.example.com/path`, `https://${'a'.repeat(55)}y.example.com/path`];
    expect(distinguishBrowserSuggestionUrls(urls, 49)).toEqual([`https://…${'a'.repeat(8)}x.example.com/path`, `https://…${'a'.repeat(8)}y.example.com/path`]);
  });

  it('keeps the first pin whole in the fallback instead of cutting it for the ellipsis', () => {
    const urls = [`https://e.co/${'a'.repeat(8)}X${'b'.repeat(30)}`, `https://e.co/${'a'.repeat(8)}Y${'b'.repeat(30)}`];
    const displays = distinguishBrowserSuggestionUrls(urls, 10, 'a');
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, 10, 'a', browserSuggestionDisplayDifference(displays, index)));
    expect(clipped).toEqual(['…aaaaaaaaX', '…aaaaaaaaY']);
    for (const display of clipped) expect(display.length).toBeLessThanOrEqual(10);
  });

  it('drops the leading ellipsis when the first pin fills the budget', () => {
    const title = `${'x'.repeat(30)}${'q'.repeat(17)}`;
    expect(clipBrowserSuggestionText(title, 17, 'q'.repeat(17))).toBe('q'.repeat(17));
    expect(clipBrowserSuggestionText(`${'x'.repeat(30)}${'q'.repeat(16)}`, 17, 'q'.repeat(16))).toBe(`…${'q'.repeat(16)}`);
  });

  it('keeps the query match and the difference anchor in one layout', () => {
    const urls = [`https://example.com/${'a'.repeat(40)}X${'b'.repeat(30)}`, `https://example.com/${'a'.repeat(40)}Y${'b'.repeat(30)}`];
    const displays = distinguishBrowserSuggestionUrls(urls, 17, 'https');
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, 17, 'https', browserSuggestionDisplayDifference(displays, index)));
    expect(clipped).toEqual(['https…le.com/…Xb…', 'https…le.com/…Yb…']);
  });

  it('keeps the query hit when the difference anchor cannot share the row', () => {
    const urls = ['https://e.co/longMtail/oregon', 'https://e.co/longNtail/oregon'];
    const displays = distinguishBrowserSuggestionUrls(urls, 17, 'oregon');
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, 17, 'oregon', browserSuggestionDisplayDifference(displays, index)));
    expect(clipped).toEqual(['…Mtail/oregon', '…Ntail/oregon']);
    for (const display of clipped) expect(display).toContain('oregon');
  });

  it('keeps a compact difference anchor beside a far query hit', () => {
    const visible = browserSuggestionVisibleChars(180);
    const urls = [`https://e.co/foo/0Z=${'x'.repeat(20)}/target`, `https://e.co/foo/0Z&${'x'.repeat(20)}/target`];
    const displays = distinguishBrowserSuggestionUrls(urls, visible, 'target');
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, visible, 'target', browserSuggestionDisplayDifference(displays, index)));
    expect(clipped).toEqual(['…=…target', '…&…target']);
    const wordy = urls.map((url) => `${url}/more/stuff`);
    const wordyDisplays = distinguishBrowserSuggestionUrls(wordy, visible, 'target');
    const wordyClipped = wordyDisplays.map((display, index) => clipBrowserSuggestionText(display, visible, 'target', browserSuggestionDisplayDifference(wordyDisplays, index)));
    expect(wordyClipped).toEqual(['…=…target/more/s…', '…&…target/more/s…']);
    for (const display of [...clipped, ...wordyClipped]) expect(display.length).toBeLessThanOrEqual(visible);
  });

  it('clips around the difference anchor when the head window cannot fit', () => {
    const urls = [`https://${'a'.repeat(60)}.com/${'x'.repeat(40)}Xy`, `https://${'a'.repeat(60)}.com/${'x'.repeat(40)}Yy`];
    const displays = distinguishBrowserSuggestionUrls(urls, 49);
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, 49, '', browserSuggestionDisplayDifference(displays, index)));
    expect(clipped).toEqual(['…aaaaaaaaaaaaaaaa.com/…xxxxxxxxxxXy', '…aaaaaaaaaaaaaaaa.com/…xxxxxxxxxxYy']);
  });

  it('measures the difference suffix from the grapheme end at the budget edge', () => {
    const urls = [`https://e.co/${'a'.repeat(20)}😀${'b'.repeat(30)}`, `https://e.co/${'a'.repeat(20)}😁${'b'.repeat(30)}`];
    expect(distinguishBrowserSuggestionUrls(urls, 23)).toEqual([`https://e.co/…😀${'b'.repeat(30)}`, `https://e.co/…😁${'b'.repeat(30)}`]);
  });

  it('collapses on whole Unicode characters when the difference is an emoji', () => {
    const urls = [`https://example.com/${'a'.repeat(30)}😀tail`, `https://example.com/${'a'.repeat(30)}😁tail`];
    expect(distinguishBrowserSuggestionUrls(urls, 24)).toEqual(['https://example.com/…😀tail', 'https://example.com/…😁tail']);
  });

  it('re-collapses colliding groups until every row is distinct', () => {
    const urls = ['https://e.co/aaaaaaaaaaXc', 'https://e.co/aaaaaaaaaac', 'https://e.co/aaaaaaaaaaXlongtail'];
    expect(distinguishBrowserSuggestionUrls(urls, 17)).toEqual(['https://e.co/…Xc', 'https://e.co/…c', 'https://e.co/…longtail']);
  });

  it('re-collapses rows whose collapsed display collides with a sibling', () => {
    const urls = ['https://e.co/x/aaaaaaa+tail', 'https://e.co/x/aaaaaaaa+tail'];
    for (const visible of [22, 24, 26]) {
      expect(new Set(distinguishBrowserSuggestionUrls(urls, visible)).size).toBe(2);
    }
    expect(distinguishBrowserSuggestionUrls(urls, 24)).toEqual(['https://e.co/…+tail', 'https://e.co/…a+tail']);
  });

  it('keeps both query words and the difference in a narrow budget', () => {
    const urls = [`https://e.co/${'a'.repeat(20)}X${'b'.repeat(20)}`, `https://e.co/${'a'.repeat(20)}Y${'b'.repeat(20)}`];
    const displays = distinguishBrowserSuggestionUrls(urls, 30, 'aaaa bbbb');
    expect(displays).toEqual(['https://e.co/aaaa…Xbbbbbbbbbbbbbbbbbbbb', 'https://e.co/aaaa…Ybbbbbbbbbbbbbbbbbbbb']);
    const clipped = displays.map((display, index) => clipBrowserSuggestionText(display, 30, 'aaaa bbbb', browserSuggestionDisplayDifference(displays, index)));
    expect(new Set(clipped).size).toBe(2);
    expect(clipped[0]).toContain('X');
    expect(clipped[1]).toContain('Y');
    for (const display of clipped) {
      expect(display.length).toBeLessThanOrEqual(30);
      expect(display).toContain('aaaa');
      expect(display).toContain('bbbb');
    }
  });

  it('keeps a match of every query word when collapsing lookalike URLs', () => {
    const urls = [
      'https://example.com/aaaaaaaaaaoregonbbbbbbbbbbmuseumcccccccccXtail',
      'https://example.com/aaaaaaaaaaoregonbbbbbbbbbbmuseumcccccccccYtail',
    ];
    for (const visible of [36, 44, 60]) {
      const displays = distinguishBrowserSuggestionUrls(urls, visible, 'oregon museum');
      expect(new Set(displays).size).toBe(2);
      for (const display of displays) {
        expect(display).toContain('oregon');
        expect(display).toContain('museum');
      }
    }
    expect(distinguishBrowserSuggestionUrls(urls, 36, 'oregon museum')).toEqual([
      'https://example.com/…oregon…museum…Xtail',
      'https://example.com/…oregon…museum…Ytail',
    ]);
  });

  it('tries later tail starts when keeping the match hides the difference', () => {
    const urls = ['https://example.com/aaaaaaaaaaoregonbbbbbbbbbbbbbbbbXtail', 'https://example.com/aaaaaaaaaaoregonbbbbbbbbbbbbbbbbYtail'];
    const displays = distinguishBrowserSuggestionUrls(urls, 30, 'oregon');
    expect(displays).toEqual(['https://example.com/…oregon…Xtail', 'https://example.com/…oregon…Ytail']);
    for (const visible of [30, 34, 40]) {
      const shown = distinguishBrowserSuggestionUrls(urls, visible, 'oregon').map((display) => display.slice(0, visible));
      expect(new Set(shown).size).toBe(2);
      for (const display of shown) expect(display).toContain('oregon');
    }
  });

  it('keeps a window around the first match when clipping long text', () => {
    const title = `${'x'.repeat(300)} Oregon ${'y'.repeat(400)}`;
    const clipped = clipBrowserSuggestionText(title, 256, 'oregon');
    expect(clipped).toHaveLength(256);
    expect(clipped.startsWith('…')).toBe(true);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).toContain(' Oregon ');
    expect(clipped.indexOf('Oregon')).toBe(25);
    const ending = `${'x'.repeat(300)} Oregon`;
    expect(clipBrowserSuggestionText(ending, 256, 'oregon')).toBe(`…${ending.slice(ending.indexOf('Oregon') - 24)}`);
    expect(clipBrowserSuggestionText(title, 256, 'xxx')).toBe(title.slice(0, 256));
    expect(clipBrowserSuggestionText(title, 256, 'seattle')).toBe(title.slice(0, 256));
    expect(clipBrowserSuggestionText('Oregon', 256, 'oregon')).toBe('Oregon');
    const url = `https://example.com/?${'a=1&'.repeat(300)}q=oregon&tail=1`;
    const clippedUrl = clipBrowserSuggestionText(url, 1024, 'oregon');
    expect(clippedUrl.length).toBeLessThanOrEqual(1024);
    expect(clippedUrl).toMatch(/^….*q=oregon&tail=1$/);
  });

  it('keeps the difference anchor when the final clip cuts a long collapsed URL', () => {
    const tail = 's'.repeat(1500);
    const urls = [
      `https://example.com/${'p'.repeat(300)}X${tail}oregon`,
      `https://example.com/${'p'.repeat(300)}Y${tail}oregon`,
    ];
    const descriptions = distinguishBrowserSuggestionUrls(urls, 49, 'oregon');
    expect(descriptions[0]).toContain('X');
    expect(descriptions[1]).toContain('Y');
    const clipped = descriptions.map((description, index) => clipBrowserSuggestionText(description, 1024, 'oregon', browserSuggestionDisplayDifference(descriptions, index)));
    expect(clipped[0]).toContain('X');
    expect(clipped[1]).toContain('Y');
    expect(clipped[0]).not.toBe(clipped[1]);
    for (const description of clipped) {
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(description).toContain('oregon');
    }
  });

  it('locates the first visible difference between displayed rows', () => {
    const displays = ['https://example.com/…oregon…Xtail', 'https://example.com/…oregon…Ytail'];
    expect(browserSuggestionDisplayDifference(displays, 0)).toBe(displays[0]!.indexOf('X'));
    expect(browserSuggestionDisplayDifference(displays, 1)).toBe(displays[1]!.indexOf('Y'));
    expect(browserSuggestionDisplayDifference([displays[0]!], 0)).toBeUndefined();
    expect(browserSuggestionDisplayDifference([displays[0]!, displays[0]!], 0)).toBeUndefined();
  });

  it('budgets wide glyphs as two columns when clipping', () => {
    expect(clipBrowserSuggestionText('汉'.repeat(60), 49, '')).toBe('汉'.repeat(24));
    const title = `${'汉'.repeat(30)}oregon`;
    expect(clipBrowserSuggestionText(title, 49, 'oregon')).toBe(`…${title.slice(22)}`);
  });

  it('budgets wide proportional latin glyphs as two columns when clipping', () => {
    const title = `${'W'.repeat(40)}oregon`;
    const clipped = clipBrowserSuggestionText(title, 49, 'oregon');
    expect(clipped).toContain('oregon');
    expect(clipped).toBe(`…${title.slice(32)}`);
  });

  it('measures the clipped segment in columns when wide glyphs cluster', () => {
    const title = `${'汉'.repeat(30)}oregon${'x'.repeat(470)}`;
    const clipped = clipBrowserSuggestionText(title, 49, 'oregon');
    expect(clipped).toBe(`…${title.slice(22, 61)}…`);
    expect(clipped).toContain('oregon');
  });

  it('moves the clip window to show a whole query that fits the budget', () => {
    const query = 'abcdefghijklmnopqrstuvwxyz1234';
    const title = `${'x'.repeat(20)}${query}${'y'.repeat(30)}`;
    const clipped = clipBrowserSuggestionText(title, 49, query);
    expect(clipped.length).toBeLessThanOrEqual(49);
    expect(clipped).toContain(query);
    expect(clipped).toBe(`…${title.slice(12, 59)}…`);
  });

  it('keeps a match of every query word when clipping long text', () => {
    const title = `${'x'.repeat(260)}oregon${'y'.repeat(234)}museum`;
    const clipped = clipBrowserSuggestionText(title, 256, 'oregon museum');
    expect(clipped.length).toBeLessThanOrEqual(256);
    expect(clipped).toContain('oregon');
    expect(clipped).toContain('museum');
    expect(clipped).toBe(`…${title.slice(236, 290)}…${title.slice(476)}`);
  });

  it('never returns an empty label when the first grapheme exceeds the budget', () => {
    const family = '👨🏿‍👩🏿‍👧🏿‍👦🏿';
    expect(clipBrowserSuggestionText(family, 17, 'oregon')).toBe(family);
    expect(clipBrowserSuggestionText(`😀${'x'.repeat(40)}`, 1, 'oregon')).toBe('😀');
  });

  it('caps the non-empty fallback at the IPC length limit', () => {
    const clustered = `a${'\u0301'.repeat(300)}`;
    const clipped = clipBrowserSuggestionText(clustered, 17, 'oregon');
    expect(clipped.length).toBeGreaterThan(0);
    expect(clipped.length).toBeLessThanOrEqual(256);
    expect(clipped).toBe(clustered.slice(0, 256));
    expect(clipBrowserSuggestionText('👨🏿‍👩🏿‍👧🏿‍👦🏿', 17, 'oregon')).toBe('👨🏿‍👩🏿‍👧🏿‍👦🏿');
  });

  it('satisfies the IPC length cap for labels with non-BMP glyphs', () => {
    const title = '𝔄'.repeat(130);
    const clipped = clipBrowserSuggestionText(title, 256, '');
    expect(clipped).toBe('𝔄'.repeat(128));
    expect(clipped.length).toBeLessThanOrEqual(256);
  });

  it('keeps the whole grapheme of a match at the clip budget edge', () => {
    const title = `${'x'.repeat(20)}e\u0301${'y'.repeat(40)}`;
    const clipped = clipBrowserSuggestionText(title, 21, 'e');
    expect(clipped).toContain('e\u0301');
    expect(clipped).toBe(`…${title.slice(12, 31)}…`);
  });

  it('clips on whole grapheme clusters', () => {
    expect(clipBrowserSuggestionText(`${'x'.repeat(255)}e\u0301 tail`, 256, '')).toBe('x'.repeat(255));
    expect(clipBrowserSuggestionText(`${'x'.repeat(254)}e\u0301 tail`, 256, '')).toBe(`${'x'.repeat(254)}e\u0301`);
    expect(clipBrowserSuggestionText(`${'x'.repeat(255)}👨‍👩‍👧 tail`, 256, '')).toBe('x'.repeat(255));
  });

  it('clips on whole Unicode characters', () => {
    const head = `${'x'.repeat(255)}😀 tail`;
    expect(clipBrowserSuggestionText(head, 256, '')).toBe('x'.repeat(255));
    const text = `${'x'.repeat(226)}😀${'x'.repeat(23)}Oregon${'z'.repeat(224)}😀${'z'.repeat(200)}`;
    expect(clipBrowserSuggestionText(text, 256, 'oregon')).toBe(`…${text.slice(228, 481)}…`);
  });

  it('keeps the end-cut display for rows without a lookalike', () => {
    const urls = [MAPS[0]!, 'https://www.google.com/maps/place/Oregon', 'https://oregon.gov/'];
    const displays = distinguishBrowserSuggestionUrls(urls, 49);
    expect(displays).toEqual(urls);
    expect(distinguishBrowserSuggestionUrls([MAPS[0]!], 49)).toEqual([MAPS[0]]);
  });

  it('leaves URLs alone when they fit or differ within the visible part', () => {
    expect(collapseBrowserSuggestionUrl('https://example.com/a/b/c', 20, 49)).toBe('https://example.com/a/b/c');
    expect(collapseBrowserSuggestionUrl(MAPS[0]!, 30, 49)).toBe(MAPS[0]);
    expect(collapseBrowserSuggestionUrl(`https://${'a'.repeat(80)}.com/x`, 60, 49)).toBe(`https://…${'a'.repeat(36)}.com/x`);
  });
});
