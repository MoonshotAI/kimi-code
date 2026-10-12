import { globPatternToRegex } from '#/_base/execEnv/globPattern';
import { describe, expect, it } from 'vitest';

describe('globPatternToRegex escaped wildcards', () => {
  it.each(['*', '?'])('matches escaped %s literally at the start of a segment', (wildcard) => {
    const regex = globPatternToRegex(`\\${wildcard}.txt`, true);

    expect(regex.test(`${wildcard}.txt`)).toBe(true);
    expect(regex.test('a.txt')).toBe(false);
    expect(regex.test('.txt')).toBe(false);
  });

  it.each(['*', '?'])('matches escaped %s literally after a filename prefix', (wildcard) => {
    const regex = globPatternToRegex(`file\\${wildcard}.txt`, true);

    expect(regex.test(`file${wildcard}.txt`)).toBe(true);
    expect(regex.test('file.txt')).toBe(false);
    expect(regex.test('fil.txt')).toBe(false);
    expect(regex.test('filee.txt')).toBe(false);
  });

  it('keeps unescaped wildcards working', () => {
    const regex = globPatternToRegex('file*.txt', true);

    expect(regex.test('file.txt')).toBe(true);
    expect(regex.test('file-1.txt')).toBe(true);
    expect(regex.test('dir/file.txt')).toBe(false);
  });
});
