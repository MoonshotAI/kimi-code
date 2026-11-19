import { describe, expect, it } from 'vitest';
import { basename } from '../src/lib/pathBasename';

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('docs/a.md')).toBe('a.md');
    expect(basename('README.md')).toBe('README.md');
  });

  it('strips trailing separators before taking the basename', () => {
    expect(basename('src/')).toBe('src');
    expect(basename('docs/nested/')).toBe('nested');
    expect(basename('docs\\nested\\')).toBe('nested');
  });

  it('handles windows and UNC separators', () => {
    expect(basename('C:\\docs\\a.md')).toBe('a.md');
    expect(basename('C:/docs/a.md')).toBe('a.md');
    expect(basename('\\\\server\\share\\docs')).toBe('docs');
  });

  it('keeps the input when no segment remains', () => {
    expect(basename('/')).toBe('/');
    expect(basename('')).toBe('');
  });
});
