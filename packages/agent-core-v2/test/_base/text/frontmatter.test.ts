import { describe, expect, it } from 'vitest';

import { FrontmatterError, parseFrontmatter } from '#/_base/text/frontmatter';

describe('parseFrontmatter', () => {
  it('parses yaml frontmatter and body', () => {
    const { data, body } = parseFrontmatter('---\nname: foo\n---\nbody text');
    expect(data).toEqual({ name: 'foo' });
    expect(body).toBe('body text');
  });

  it('returns null data when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just body');
    expect(data).toBeNull();
    expect(body).toBe('just body');
  });

  it('throws when the closing fence is missing', () => {
    expect(() => parseFrontmatter('---\nname: foo')).toThrow(FrontmatterError);
  });
});
