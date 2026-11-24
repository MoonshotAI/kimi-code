import { describe, expect, it } from 'vitest';
import { isMarkdownCodeHeader, markdownFenceSources } from './codePreview';

describe('markdownFenceSources', () => {
  it('accepts whitespace before the language and keeps source order', () => {
    expect(markdownFenceSources('``` markdown\nfirst\n```\n\n~~~\tmd\nsecond\n~~~\n\n```markdown\nthird\n```'))
      .toEqual(['first\n', 'second\n', 'third\n']);
  });
  it('preserves whitespace, blank lines and long source without reading rendered rows', () => {
    const source = '# Title\n\n' + '  content\n'.repeat(3000);
    expect(markdownFenceSources('```markdown\n' + source + '```')).toEqual([source]);
  });

  it('keeps nested list fences in order and accepts aliases and tilde fences', () => {
    expect(markdownFenceSources('- item\n\n  ```md\n  **first**\n  ```\n\n~~~Markdown\nsecond\n~~~'))
      .toEqual(['**first**\n', 'second\n']);
  });

  it('does not mistake an example inside a longer non-Markdown fence for a real fence', () => {
    expect(markdownFenceSources('````text\n```markdown\n# example\n```\n````')).toEqual([]);
  });

  it('includes fences carrying a filename title so DOM source indexes stay aligned', () => {
    expect(markdownFenceSources('```markdown README.md\n# doc\n```\n\n```markdown\nplain\n```')).toEqual(['# doc\n', 'plain\n']);
  });
});

describe('isMarkdownCodeHeader', () => {
  it('accepts plain language titles and aliases in any case', () => {
    expect(isMarkdownCodeHeader('Markdown', null)).toBe(true);
    expect(isMarkdownCodeHeader('Md', null)).toBe(true);
    expect(isMarkdownCodeHeader(' markdown ', null)).toBe(true);
  });

  it('accepts a filename title when the caption carries the language', () => {
    expect(isMarkdownCodeHeader('README.md', 'Markdown')).toBe(true);
    expect(isMarkdownCodeHeader('notes.md', 'Md')).toBe(true);
  });

  it('rejects non-Markdown blocks even with Markdown-looking filenames', () => {
    expect(isMarkdownCodeHeader('markdown.md', 'Text')).toBe(false);
    expect(isMarkdownCodeHeader('notes.md', 'Python')).toBe(false);
    expect(isMarkdownCodeHeader('Plain Text', null)).toBe(false);
    expect(isMarkdownCodeHeader(null, undefined)).toBe(false);
  });
});
