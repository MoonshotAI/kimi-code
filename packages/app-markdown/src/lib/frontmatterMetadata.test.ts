import { describe, expect, it } from 'vitest';
import { frontmatterMetadata } from './frontmatterMetadata';

describe('frontmatterMetadata', () => {
  it('preserves field order, dates, Chinese values and tags', () => {
    expect(frontmatterMetadata('created: 2026-09-09\nstatus: 待研究\ntags: [kimi-code, browser, research]')).toEqual([
      { key: 'created', value: '2026-09-09', tags: null },
      { key: 'status', value: '待研究', tags: null },
      { key: 'tags', value: '- kimi-code\n- browser\n- research', tags: ['kimi-code', 'browser', 'research'] },
    ]);
  });

  it('handles block lists, multiline strings and scalar types', () => {
    expect(frontmatterMetadata('tags:\n  - a\n  - b\ndescription: |\n  first\n  second\nenabled: false\ncount: 0\nempty: null')).toEqual([
      { key: 'tags', value: '- a\n- b', tags: ['a', 'b'] },
      { key: 'description', value: 'first\nsecond\n', tags: null },
      { key: 'enabled', value: 'false', tags: null },
      { key: 'count', value: '0', tags: null },
      { key: 'empty', value: '—', tags: null },
    ]);
  });

  it('retains nested data and empty arrays as structured text', () => {
    expect(frontmatterMetadata('author: {name: Moon}\nitems: [{id: 1}]\ntags: []')).toEqual([
      { key: 'author', value: 'name: Moon', tags: null },
      { key: 'items', value: '- id: 1', tags: null },
      { key: 'tags', value: '[]', tags: null },
    ]);
  });

  it.each([
    'name: [broken', 'name: a\nname: b', 'plain text', '- a\n- b', '# comment',
    'value: !custom data', 'value: &ref [*ref]', 'base: &ref [a]\ncopy: *ref',
    '? [a, b]\n: value', 'x'.repeat(65_537),
  ])('falls back to source for unsupported or invalid metadata', (source) => {
    expect(frontmatterMetadata(source)).toBeNull();
  });

  it('treats HTML and special property names as data', () => {
    expect(frontmatterMetadata('__proto__: safe\nhtml: <img src=x onerror=alert(1)>')).toEqual([
      { key: '__proto__', value: 'safe', tags: null },
      { key: 'html', value: '<img src=x onerror=alert(1)>', tags: null },
    ]);
  });
});
