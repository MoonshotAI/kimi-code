import { describe, expect, it } from 'vitest';
import { mentionHrefToPath } from '../src/mentionLinkPath';

describe('mentionHrefToPath', () => {
  it('returns plain paths unchanged', () => {
    expect(mentionHrefToPath('docs/a.md')).toBe('docs/a.md');
    expect(mentionHrefToPath('/abs/dir/folder/')).toBe('/abs/dir/folder/');
  });

  it('decodes percent-encoded spaces and non-ASCII characters', () => {
    expect(mentionHrefToPath('docs/my%20file.md')).toBe('docs/my file.md');
    expect(mentionHrefToPath('%E4%B8%AD%E6%96%87/%E7%AC%94%E8%AE%B0.md')).toBe('中文/笔记.md');
  });

  it('decodes percent-encoded # and ? back to filename characters', () => {
    expect(mentionHrefToPath('docs/a%23b.md')).toBe('docs/a#b.md');
    expect(mentionHrefToPath('docs/a%3Fb.md')).toBe('docs/a?b.md');
  });

  it('decodes the composer’s %25 encoding back to a literal percent', () => {
    // The composer percent-encodes '%' in mention dests, so a real filename
    // like 'a%20b.md' travels as 'a%2520b.md' and decodes back losslessly
    // instead of collapsing to 'a b.md'. Same for a literal '%2F', which must
    // not turn into a path separator.
    expect(mentionHrefToPath('docs/a%2520b.md')).toBe('docs/a%20b.md');
    expect(mentionHrefToPath('docs/a%252Fb.md')).toBe('docs/a%2Fb.md');
  });

  it('keeps raw # and ? as filename characters instead of stripping them', () => {
    // Mention hrefs are raw paths, not URLs: no fragment/query semantics.
    expect(mentionHrefToPath('docs/a#b.md')).toBe('docs/a#b.md');
    expect(mentionHrefToPath('docs/a?b.md')).toBe('docs/a?b.md');
  });

  it('falls back to the raw href on malformed percent sequences', () => {
    expect(mentionHrefToPath('docs/100%.md')).toBe('docs/100%.md');
    expect(mentionHrefToPath('docs/%zz.md')).toBe('docs/%zz.md');
    expect(mentionHrefToPath('docs/trailing%')).toBe('docs/trailing%');
    // Lone surrogate halves of a UTF-8 sequence are malformed too.
    expect(mentionHrefToPath('docs/%E4%B8.md')).toBe('docs/%E4%B8.md');
  });
});
