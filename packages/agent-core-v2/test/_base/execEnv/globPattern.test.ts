/**
 * `_base/execEnv` (L0) — glob character-class scenarios for `globPatternToRegex`.
 *
 * Covers the POSIX / Python `fnmatch` rules that diverge from JS regex: a `]`
 * in the first position of the class body is a literal member rather than the
 * terminator (`fnmatch.fnmatch('].txt', '[]].txt')` is `True`), a `]` closing a
 * non-empty class stays the terminator, an unclosed `[` degrades to a literal
 * bracket, and a class that is a legal glob but an invalid JS regex matches
 * nothing rather than throwing.
 */

import { describe, expect, it } from 'vitest';

import { globPatternToRegex } from '#/_base/execEnv/globPattern';

describe('globPatternToRegex', () => {
  it('treats a leading ] inside a character class as a literal member', () => {
    const regex = globPatternToRegex('[]].txt', true);

    expect(regex.test('].txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(false);
  });

  it('treats a leading ] after ! as a literal member of a negated class', () => {
    const regex = globPatternToRegex('[!]].txt', true);

    expect(regex.test('].txt')).toBe(false);
    expect(regex.test('a.txt')).toBe(true);
  });

  it('keeps other members of a class that starts with a literal ]', () => {
    const regex = globPatternToRegex('[]a].txt', true);

    expect(regex.test('].txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(true);
    expect(regex.test('b.txt')).toBe(false);
  });

  it('does not absorb a ] that closes a non-empty class', () => {
    const regex = globPatternToRegex('[a]].txt', true);

    expect(regex.test('a].txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(false);
  });

  it('still treats an unclosed [ as a literal bracket', () => {
    const regex = globPatternToRegex('file[', true);

    expect(regex.test('file[')).toBe(true);
    expect(regex.test('file]')).toBe(false);
  });

  it('matches nothing instead of throwing on a reversed range', () => {
    for (const pattern of ['[]--]', '[a--]', '[z-a]']) {
      const regex = globPatternToRegex(pattern, true);

      expect(regex.test(']')).toBe(false);
      expect(regex.test('a')).toBe(false);
      expect(regex.test('-')).toBe(false);
    }
  });
});
