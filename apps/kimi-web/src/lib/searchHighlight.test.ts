// apps/kimi-web/src/lib/searchHighlight.test.ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeRegExp, highlightHtml, snippet } from './searchHighlight';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
});

describe('escapeRegExp', () => {
  it('escapes regexp metacharacters so the source matches literally', () => {
    const q = 'a.*(b+c)?';
    expect(new RegExp(escapeRegExp(q)).test(q)).toBe(true);
    // Without escaping, `a.*(b+c)?` would also match other strings.
    expect(new RegExp(escapeRegExp(q)).test('aXXXbc')).toBe(false);
  });
});

describe('snippet', () => {
  it('returns the head when the query is empty', () => {
    expect(snippet('hello world', '', 3)).toBe('hello …');
  });

  it('returns the head when the query is not found', () => {
    expect(snippet('hello world', 'zzz', 3)).toBe('hello …');
  });

  it('matches at the start: no leading ellipsis, trailing ellipsis when clipped', () => {
    expect(snippet('hello world this is a long sentence', 'hello', 4)).toBe('hello wor…');
  });

  it('matches in the middle: leading and trailing ellipses', () => {
    expect(snippet('the quick brown fox jumps over the lazy dog', 'fox', 4)).toBe('…own fox jum…');
  });

  it('matches at the end: leading ellipsis, no trailing ellipsis', () => {
    expect(snippet('the quick brown fox jumps over the lazy dog', 'dog', 4)).toBe('…azy dog');
  });

  it('is case-insensitive', () => {
    expect(snippet('Hello World', 'world', 10)).toBe('Hello World');
  });

  it('collapses newlines into spaces', () => {
    expect(snippet('line one\n\nline two', 'two', 40)).toBe('line one line two');
  });

  it('returns the whole text when it fits within the window', () => {
    expect(snippet('short', 'short', 40)).toBe('short');
  });
});

describe('highlightHtml', () => {
  it('wraps the match in <mark>', () => {
    expect(highlightHtml('hello world', 'world')).toBe('hello <mark>world</mark>');
  });

  it('is case-insensitive and highlights all occurrences', () => {
    expect(highlightHtml('Foo foo FOO', 'foo')).toBe(
      '<mark>Foo</mark> <mark>foo</mark> <mark>FOO</mark>',
    );
  });

  it('escapes HTML in the source before highlighting (no script injection)', () => {
    const out = highlightHtml('<script>alert(1)</script>', 'script');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;<mark>script</mark>&gt;');
  });

  it('does not throw on regexp-special queries and matches them literally', () => {
    expect(() => highlightHtml('a.*b', '.*')).not.toThrow();
    expect(highlightHtml('a.*b', '.*')).toBe('a<mark>.*</mark>b');
  });

  it('matches a query that contains HTML-significant characters', () => {
    expect(highlightHtml('a&b&c', '&')).toBe('a<mark>&amp;</mark>b<mark>&amp;</mark>c');
  });

  it('returns the escaped text unchanged when the query is empty', () => {
    expect(highlightHtml('<b>hi</b>', '')).toBe('&lt;b&gt;hi&lt;/b&gt;');
  });
});
