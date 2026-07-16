import { describe, expect, it } from 'vitest';

import { FrontmatterError, parseFrontmatter } from '../../src/skill/parser';

describe('parseFrontmatter', () => {
  it('parses a leading YAML block and discards it from body', () => {
    const text = ['---', 'name: test-skill', 'description: A test skill', 'extra: 123', '---', '', '# Body', ''].join(
      '\n',
    );

    const { data, body } = parseFrontmatter(text);

    expect(data).toEqual({
      name: 'test-skill',
      description: 'A test skill',
      extra: 123,
    });
    expect(body).not.toContain('extra: 123');
    expect(body).toContain('# Body');
  });

  it('throws FrontmatterError on invalid YAML', () => {
    const text = ['---', 'name: "unterminated', 'description: oops', '---', ''].join('\n');

    expect(() => parseFrontmatter(text)).toThrow(FrontmatterError);
  });

  it('returns empty data and whole body when no frontmatter fence exists', () => {
    const text = '# Just a body\n\nNo frontmatter here.\n';
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });

  it('returns empty data for an empty frontmatter block (dashed-only)', () => {
    const text = ['---', '---', '', 'Body content'].join('\n');
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toContain('Body content');
  });

  it('handles frontmatter with only whitespace values', () => {
    const text = ['---', 'key: ', 'another:   ', '---', '', 'Body'].join('\n');
    const { data, body } = parseFrontmatter(text);
    expect(data).toHaveProperty('key');
    expect(data).toHaveProperty('another');
    expect(body).toContain('Body');
  });

  it('treats body with no frontmatter as single block', () => {
    const text = 'Some content\n---\nMore content\n---\nEnd';
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });

  it('parses boolean and numeric YAML values correctly', () => {
    const text = ['---', 'enabled: true', 'count: 42', 'rate: 3.14', '---', '', 'Body'].join('\n');
    const { data } = parseFrontmatter(text);
    expect(data).toEqual({ enabled: true, count: 42, rate: 3.14 });
  });

  it('throws FrontmatterError for a YAML syntax error (colon without value)', () => {
    const text = ['---', 'name: "test"', 'broken : : key', '---', ''].join('\n');
    expect(() => parseFrontmatter(text)).toThrow(FrontmatterError);
  });
});
