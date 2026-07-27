import { describe, expect, it } from 'vitest';

import { globPatternToRegex } from '#/_base/execEnv/globPattern';

describe('globPatternToRegex', () => {
  it('treats a leading ] inside a character class as a literal member', () => {
    // Python: fnmatch.fnmatch('].txt', '[]].txt') is True. Reading the `]` as
    // the terminator instead would leave an empty class, which matches nothing,
    // so the pattern would stop matching altogether.
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
    // `[a]` is the class, the second `]` is a literal character after it.
    const regex = globPatternToRegex('[a]].txt', true);

    expect(regex.test('a].txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(false);
  });

  it('still treats an unclosed [ as a literal bracket', () => {
    const regex = globPatternToRegex('file[', true);

    expect(regex.test('file[')).toBe(true);
    expect(regex.test('file]')).toBe(false);
  });
});
