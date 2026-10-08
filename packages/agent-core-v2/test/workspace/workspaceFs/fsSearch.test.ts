import { describe, expect, it } from 'vitest';

import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  globCanMatchBelow,
  matchesAnyGlob,
  rgPath,
  stripTrailingNewline,
} from '#/workspace/workspaceFs/internal/fsSearch';

describe('computeFuzzyScore', () => {
  it('returns 0 for an empty query', () => {
    expect(computeFuzzyScore('anything', '')).toBe(0);
  });

  it('returns 0 when the query is not a subsequence', () => {
    expect(computeFuzzyScore('abc', 'az')).toBe(0);
  });

  it('returns 1 for a subsequence match and 0 otherwise', () => {
    expect(computeFuzzyScore('foo-bar', 'foo')).toBe(1);
    expect(computeFuzzyScore('bar-foo', 'foo')).toBe(1);
    expect(computeFuzzyScore('abc', 'xyz')).toBe(0);
  });
});

describe('computeMatchPositions', () => {
  it('returns the matched character indices', () => {
    expect(computeMatchPositions('src/foo.ts', 'foo')).toEqual([4, 5, 6]);
  });

  it('returns empty when query does not match in order', () => {
    expect(computeMatchPositions('abc', 'ca')).toEqual([]);
  });
});

describe('matchesAnyGlob', () => {
  it('matches a single-segment wildcard', () => {
    expect(matchesAnyGlob('src/a.ts', ['*.ts'])).toBe(false);
    expect(matchesAnyGlob('a.ts', ['*.ts'])).toBe(true);
  });

  it('matches a recursive wildcard', () => {
    expect(matchesAnyGlob('src/a.ts', ['**/*.ts'])).toBe(true);
    expect(matchesAnyGlob('src/a.js', ['**/*.ts'])).toBe(false);
  });

  it('preserves segment boundaries around recursive wildcards', () => {
    expect(matchesAnyGlob('ignored-dir/keep.txt', ['ignored-dir/**/keep.txt'])).toBe(true);
    expect(matchesAnyGlob('ignored-dir/sub/keep.txt', ['ignored-dir/**/keep.txt'])).toBe(true);
    expect(matchesAnyGlob('ignored-dir/notkeep.txt', ['ignored-dir/**/keep.txt'])).toBe(false);
    expect(matchesAnyGlob('keep.txt', ['**/keep.txt'])).toBe(true);
    expect(matchesAnyGlob('notkeep.txt', ['**/keep.txt'])).toBe(false);
    expect(matchesAnyGlob('a/xxb', ['a/**/b'])).toBe(false);
  });

  it('treats globstars inside a path segment as within-segment wildcards', () => {
    expect(matchesAnyGlob('foo/keep.txt', ['foo**/keep.txt'])).toBe(true);
    expect(matchesAnyGlob('fooX/keep.txt', ['foo**/keep.txt'])).toBe(true);
    expect(matchesAnyGlob('foo/sub/keep.txt', ['foo**/keep.txt'])).toBe(false);
    expect(matchesAnyGlob('foobar', ['foo**'])).toBe(true);
    expect(matchesAnyGlob('foo/bar', ['foo**'])).toBe(false);
  });
});

describe('globCanMatchBelow', () => {
  it('detects a literal-prefix ancestor of a nested glob', () => {
    expect(globCanMatchBelow('ignored-dir', ['ignored-dir/keep.txt'])).toBe(true);
    expect(globCanMatchBelow('ignored-dir', ['ignored-dir/**'])).toBe(true);
    expect(globCanMatchBelow('a', ['a/b/c'])).toBe(true);
    expect(globCanMatchBelow('a/b', ['a/b/c'])).toBe(true);
  });

  it('detects ancestors across wildcard segments', () => {
    expect(globCanMatchBelow('ignored-a', ['ignored-*/keep.txt'])).toBe(true);
    expect(globCanMatchBelow('ignored-dir/sub', ['ignored-dir/**/keep.txt'])).toBe(true);
    expect(globCanMatchBelow('ignored-dir', ['ignored-dir/**/keep.txt'])).toBe(true);
    expect(globCanMatchBelow('src', ['**/keep.txt'])).toBe(true);
  });

  it('rejects non-ancestors and non-matching segments', () => {
    expect(globCanMatchBelow('ignored', ['ignored-dir/keep.txt'])).toBe(false);
    expect(globCanMatchBelow('other-dir', ['ignored-dir/keep.txt'])).toBe(false);
    expect(globCanMatchBelow('src', ['*.txt'])).toBe(false);
    expect(globCanMatchBelow('ignored-b', ['ignored-a/keep.txt'])).toBe(false);
    expect(globCanMatchBelow('ignored-dir/sub', ['ignored-dir/nested/keep.txt'])).toBe(false);
  });

  it('handles brace and single-segment constructs via whole-pattern parsing', () => {
    expect(globCanMatchBelow('ignored-a', ['{ignored-a/keep.txt,other}'])).toBe(true);
    expect(globCanMatchBelow('a', ['{a,b}/keep.txt'])).toBe(true);
    expect(globCanMatchBelow('c', ['{a,b}/keep.txt'])).toBe(false);
    expect(globCanMatchBelow('src', ['keep.txt'])).toBe(false);
    expect(globCanMatchBelow('anything', ['**'])).toBe(true);
    expect(globCanMatchBelow('a', ['{a/b,c}/x'])).toBe(true);
  });

  it('treats empty patterns as non-matching', () => {
    expect(matchesAnyGlob('keep.txt', [''])).toBe(false);
    expect(matchesAnyGlob('a.ts', ['', '*.ts'])).toBe(true);
    expect(globCanMatchBelow('src', [''])).toBe(false);
  });

  it('treats leading exclamation marks as literal characters', () => {
    expect(matchesAnyGlob('!foo', ['!foo'])).toBe(true);
    expect(matchesAnyGlob('foo', ['!foo'])).toBe(false);
    expect(matchesAnyGlob('bar', ['!foo'])).toBe(false);
    expect(globCanMatchBelow('!foo', ['!foo/keep.txt'])).toBe(true);
  });

  it('treats empty path segments as non-matching without throwing', () => {
    expect(globCanMatchBelow('a', ['a//b'])).toBe(true);
    expect(globCanMatchBelow('a/b', ['a//b'])).toBe(false);
  });

  it('handles deeply segmented globs without exhausting the call stack', () => {
    expect(globCanMatchBelow('a/b', [`${'**/'.repeat(5000)}keep.txt`])).toBe(true);
    expect(globCanMatchBelow('a/b', [`${'x/'.repeat(5000)}keep.txt`])).toBe(false);
  });
});

describe('compileGrepPattern', () => {
  it('treats the pattern as fixed text when regex is false', () => {
    const re = compileGrepPattern({
      pattern: 'a.b',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('aXb')).toBe(false);
    expect(re.test('a.b')).toBe(true);
  });

  it('honors case-insensitive matching', () => {
    const re = compileGrepPattern({
      pattern: 'foo',
      regex: false,
      case_sensitive: false,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('FOO')).toBe(true);
  });
});

describe('stripTrailingNewline', () => {
  it('strips a trailing LF', () => {
    expect(stripTrailingNewline('a\n')).toBe('a');
  });

  it('strips a trailing CRLF', () => {
    expect(stripTrailingNewline('a\r\n')).toBe('a');
  });

  it('leaves other text untouched', () => {
    expect(stripTrailingNewline('a\nb')).toBe('a\nb');
  });
});

describe('rgPath', () => {
  it('returns the text field', () => {
    expect(rgPath({ text: 'src/a.ts' })).toBe('src/a.ts');
  });

  it('strips a leading ./', () => {
    expect(rgPath({ text: './src/a.ts' })).toBe('src/a.ts');
  });

  it('decodes the bytes field as base64', () => {
    expect(rgPath({ bytes: Buffer.from('src/a.ts', 'utf-8').toString('base64') })).toBe(
      'src/a.ts',
    );
  });

  it('returns undefined for missing input', () => {
    expect(rgPath(undefined)).toBeUndefined();
  });
});
