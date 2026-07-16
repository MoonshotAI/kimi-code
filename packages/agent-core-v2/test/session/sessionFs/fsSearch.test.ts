import { describe, expect, it } from 'vitest';

import {
  compileGrepPattern,
  computeFuzzyScore,
  computeMatchPositions,
  matchesAnyGlob,
  rgPath,
  stripTrailingNewline,
} from '#/session/sessionFs/fsSearch';

describe('computeFuzzyScore', () => {
  it('returns 0 for an empty query', () => {
    expect(computeFuzzyScore('anything', '')).toBe(0);
  });

  it('returns 0 for an empty target', () => {
    expect(computeFuzzyScore('', 'q')).toBe(0);
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

  it('matches with multiple glob patterns', () => {
    expect(matchesAnyGlob('a.ts', ['*.js', '*.ts'])).toBe(true);
    expect(matchesAnyGlob('a.js', ['*.js', '*.ts'])).toBe(true);
    expect(matchesAnyGlob('a.css', ['*.js', '*.ts'])).toBe(false);
  });

  it('matches against an empty pattern list', () => {
    expect(matchesAnyGlob('a.ts', [])).toBe(false);
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

  it('treats the pattern as regex when regex is true', () => {
    const re = compileGrepPattern({
      pattern: 'foo\\d+',
      regex: true,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('foo123')).toBe(true);
    expect(re.test('foo')).toBe(false);
  });

  it('handles regex special characters in fixed-string mode', () => {
    const re = compileGrepPattern({
      pattern: '(a.b)',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(re.test('(a.b)')).toBe(true);
    expect(re.test('aXb')).toBe(false);
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

  it('strips multiple trailing newlines', () => {
    expect(stripTrailingNewline('a\n\n')).toBe('a');
  });

  it('strips CRLF from the end of a multi-line string', () => {
    expect(stripTrailingNewline('a\nb\r\n')).toBe('a\nb');
  });

  it('leaves an empty string empty', () => {
    expect(stripTrailingNewline('')).toBe('');
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

  it('decodes the bytes field as base64 with special characters', () => {
    expect(rgPath({ bytes: Buffer.from('path/with spaces/file.js', 'utf-8').toString('base64') })).toBe(
      'path/with spaces/file.js',
    );
  });
});

describe('computeMatchPositions', () => {
  it('finds positions in the middle of a string', () => {
    expect(computeMatchPositions('prefix-src/foo.ts-suffix', 'foo')).toEqual([12, 13, 14]);
  });

  it('returns empty for a query longer than the target', () => {
    expect(computeMatchPositions('abc', 'abcd')).toEqual([]);
  });
});
