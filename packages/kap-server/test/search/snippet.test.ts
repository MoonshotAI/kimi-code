import { describe, expect, it } from 'vitest';

import { makeSnippet } from '../../src/search/snippet';

describe('makeSnippet', () => {
  it('centers the window on the first hit term', () => {
    const text = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    const snippet = makeSnippet(text, 'needle', 20);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });

  it('matches case-insensitively', () => {
    expect(makeSnippet('Hello World', 'hello')).toBe('Hello World');
  });

  it('matches CJK terms', () => {
    const snippet = makeSnippet('我们需要重构全局搜索模块以支持中文', '搜索');
    expect(snippet).toContain('搜索');
  });

  it('uses the earliest occurrence across multiple terms', () => {
    const text = `${'x'.repeat(100)} beta ${'x'.repeat(100)} alpha`;
    const snippet = makeSnippet(text, 'alpha beta', 10);
    expect(snippet).toContain('beta');
  });

  it('falls back to the text head when no term matches', () => {
    const text = `start ${'y'.repeat(500)}`;
    const snippet = makeSnippet(text, 'absent', 40);
    expect(snippet.startsWith('start')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('does not add ellipses when the whole text fits', () => {
    expect(makeSnippet('short text', 'text')).toBe('short text');
  });

  it('collapses whitespace runs', () => {
    expect(makeSnippet('a\n\nb   c\tneedle', 'needle', 80)).toBe('a b c needle');
  });
});
