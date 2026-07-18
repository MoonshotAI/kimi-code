import { describe, expect, it } from 'vitest';

import { parseNumstat, parsePorcelain, parsePullRequest } from '#/app/git/gitParsers';

describe('parsePorcelain', () => {
  it('parses branch header and ahead/behind', () => {
    const out = '## main...origin/main [ahead 2, behind 3]\n';
    const result = parsePorcelain(out, undefined);
    expect(result.branch).toBe('main');
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(3);
    expect(result.entries).toEqual({});
  });

  it('classifies modified, untracked, renamed, and deleted entries', () => {
    const out = [
      '## dev',
      ' M src/a.ts',
      '?? src/b.ts',
      'R  old.ts -> new.ts',
      'D  src/c.ts',
      '',
    ].join('\n');
    const result = parsePorcelain(out, undefined);
    expect(result.branch).toBe('dev');
    expect(result.entries).toEqual({
      'src/a.ts': 'modified',
      'src/b.ts': 'untracked',
      'new.ts': 'renamed',
      'src/c.ts': 'deleted',
    });
  });

  it('applies the path filter when provided', () => {
    const out = '## main\n M src/a.ts\n M src/b.ts\n';
    const result = parsePorcelain(out, new Set(['src/a.ts']));
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
  });
});

describe('parseNumstat', () => {
  it('sums added and deleted lines across files', () => {
    const out = '10\t2\tsrc/a.ts\n3\t0\tsrc/b.ts\n';
    expect(parseNumstat(out)).toEqual({ additions: 13, deletions: 2 });
  });

  it('treats binary file markers as zero', () => {
    const out = '-\t-\timage.png\n5\t1\tsrc/a.ts\n';
    expect(parseNumstat(out)).toEqual({ additions: 5, deletions: 1 });
  });

  it('returns zeros for empty output', () => {
    expect(parseNumstat('')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('parsePullRequest', () => {
  it('normalizes a valid open PR', () => {
    const out = '{"number":12,"url":"https://github.com/acme/repo/pull/12","state":"OPEN"}';
    expect(parsePullRequest(out)).toEqual({
      number: 12,
      state: 'open',
      url: 'https://github.com/acme/repo/pull/12',
    });
  });

  it('returns null for malformed json', () => {
    expect(parsePullRequest('not json')).toBeNull();
  });

  it('returns null for a non-http url', () => {
    const out = '{"number":1,"url":"ftp://x/y","state":"open"}';
    expect(parsePullRequest(out)).toBeNull();
  });

  it('returns null for an unknown state', () => {
    const out = '{"number":1,"url":"https://x/y","state":"weird"}';
    expect(parsePullRequest(out)).toBeNull();
  });

  it('returns null when url contains control chars', () => {
    const out = '{"number":1,"url":"https://x/y\\u0000","state":"open"}';
    expect(parsePullRequest(out)).toBeNull();
  });
});
