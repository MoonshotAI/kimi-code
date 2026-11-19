import { describe, expect, it } from 'vitest';
import { markdownTableSources } from './tableSource';

describe('markdownTableSources', () => {
  it('returns the raw source of every table in document order', () => {
    const text = '# T\n\n| Name | Type |\n| --- | --- |\n| **Alpha** | `service` |\n\ntext\n\n| Second |\n| --- |\n| [x](https://e.com) |\n';
    expect(markdownTableSources(text)).toEqual([
      '| Name | Type |\n| --- | --- |\n| **Alpha** | `service` |',
      '| Second |\n| --- |\n| [x](https://e.com) |',
    ]);
  });

  it('ignores pipe-looking lines inside fenced code', () => {
    const text = '```\n| not | a table |\n| --- | --- |\n```\n\n| real |\n| --- |\n| x |\n';
    expect(markdownTableSources(text)).toEqual(['| real |\n| --- |\n| x |']);
  });

  it('keeps the blockquote prefix on nested tables so indexes stay aligned', () => {
    const text = '> | q1 | q2 |\n> | --- | --- |\n> | a | b |\n\n| outer |\n| --- |\n| y |\n';
    expect(markdownTableSources(text)).toEqual([
      '> | q1 | q2 |\n> | --- | --- |\n> | a | b |',
      '| outer |\n| --- |\n| y |',
    ]);
  });

  it('accepts tables without leading or trailing pipes', () => {
    const text = 'Name | Type\n--- | ---\nAlpha | service\n';
    expect(markdownTableSources(text)).toEqual(['Name | Type\n--- | ---\nAlpha | service']);
  });

  it('returns an empty list when there is no table or no pipe at all', () => {
    expect(markdownTableSources('plain text only')).toEqual([]);
    expect(markdownTableSources('| just a pipe in a paragraph\n')).toEqual([]);
    expect(markdownTableSources('')).toEqual([]);
  });
});
