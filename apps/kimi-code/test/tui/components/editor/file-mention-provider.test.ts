import { describe, it, expect } from 'vitest';

import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import type { GitLsFilesCache, GitSnapshot } from '#/utils/git/git-ls-files';

function stubGitCache(
  files: string[] | null,
  opts: { mtimes?: Record<string, number>; recency?: string[] } = {},
): GitLsFilesCache {
  const snapshot: GitSnapshot | null =
    files === null
      ? null
      : {
          files,
          mtimeByPath: new Map(Object.entries(opts.mtimes ?? {})),
          recencyOrder: new Map((opts.recency ?? []).map((p, i) => [p, i])),
        };
  return {
    isGitRepo: () => files !== null,
    getSnapshot: () => snapshot,
    list: () => (files === null ? null : files.slice()),
  };
}

function ctrl(): AbortSignal {
  return new AbortController().signal;
}

const NO_FD = null;
const GOAL_COMMAND = {
  name: 'goal',
  description: 'Start or manage a goal',
  getArgumentCompletions: (prefix: string) =>
    prefix.length === 0
      ? [
          {
            value: 'status',
            label: 'status',
          },
        ]
      : null,
};

describe('FileMentionProvider — @ prefix detection + git-backed suggestions', () => {
  it('returns null when there is no @ mention and the dir is empty', async () => {
    const provider = new FileMentionProvider([], '/nonexistent', NO_FD, stubGitCache([]));
    const result = await provider.getSuggestions(['hello world'], 0, 11, { signal: ctrl() });
    // pi-tui inner will also return null for non-path plain text.
    expect(result).toBeNull();
  });

  it('does not complete slash arguments before existing free text', async () => {
    const provider = new FileMentionProvider([GOAL_COMMAND], '/repo', NO_FD, stubGitCache([]));
    const line = '/goal Fix the checkout docs';
    const result = await provider.getSuggestions([line], 0, '/goal '.length, { signal: ctrl() });
    expect(result).toBeNull();
  });

  it('still completes slash arguments at the end of an empty argument', async () => {
    const provider = new FileMentionProvider([GOAL_COMMAND], '/repo', NO_FD, stubGitCache([]));
    const line = '/goal ';
    const result = await provider.getSuggestions([line], 0, line.length, { signal: ctrl() });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('');
    expect(result!.items.map((item) => item.value)).toEqual(['status']);
  });

  it('bare @ surfaces the first files as a starting list', async () => {
    const files = ['a.ts', 'b.ts', 'src/c.ts'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('@');
    expect(result!.items.map((i) => i.value)).toEqual(['@a.ts', '@b.ts', '@src/c.ts']);
  });

  it('ranks basename-prefix > substring > fuzzy', async () => {
    const files = [
      'docs/readme.md', // basename starts with "read"
      'src/readability.ts', // basename starts with "read"
      'lib/threader.ts', // basename contains "read" (substring)
    ];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@read'], 0, 5, { signal: ctrl() });
    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    const readabilityIdx = values.indexOf('@src/readability.ts');
    const readmeIdx = values.indexOf('@docs/readme.md');
    const threadIdx = values.indexOf('@lib/threader.ts');
    // Both starts-with entries rank ahead of the substring entry.
    expect(readabilityIdx).toBeGreaterThanOrEqual(0);
    expect(readmeIdx).toBeGreaterThanOrEqual(0);
    expect(threadIdx).toBeGreaterThan(Math.max(readabilityIdx, readmeIdx));
  });

  it('empty query prefers recently-edited files over everything else', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const provider = new FileMentionProvider(
      [],
      '/repo',
      NO_FD,
      stubGitCache(files, {
        recency: ['d.ts', 'b.ts'], // d most recent, then b
      }),
    );
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const values = result!.items.map((i) => i.value);
    // Recency layer fills first, then alphabetical layer.
    expect(values.slice(0, 2)).toEqual(['@d.ts', '@b.ts']);
    expect(values.slice(2)).toEqual(['@a.ts', '@c.ts', '@e.ts']);
  });

  it('empty query falls back to mtime when no recency info', async () => {
    const files = ['old.ts', 'newer.ts', 'newest.ts'];
    const provider = new FileMentionProvider(
      [],
      '/repo',
      NO_FD,
      stubGitCache(files, {
        mtimes: { 'old.ts': 1000, 'newer.ts': 2000, 'newest.ts': 3000 },
      }),
    );
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const values = result!.items.map((i) => i.value);
    expect(values).toEqual(['@newest.ts', '@newer.ts', '@old.ts']);
  });

  it('empty query falls back to basename alphabetical when no signals', async () => {
    const files = ['zoo/apple.ts', 'banana.ts', 'cherry.ts'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const values = result!.items.map((i) => i.value);
    // Sorted by basename alphabetical: apple, banana, cherry
    expect(values).toEqual(['@zoo/apple.ts', '@banana.ts', '@cherry.ts']);
  });

  it('hides dot-dir files from the default list', async () => {
    const files = ['.agents/skills/x.md', '.github/workflows/y.yml', 'src/a.ts', 'README.md'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@README.md');
    expect(values).toContain('@src/a.ts');
    expect(values).not.toContain('@.agents/skills/x.md');
    expect(values).not.toContain('@.github/workflows/y.yml');
  });

  it('shows dot-dir files when the query explicitly opts in (starts with .)', async () => {
    const files = ['.agents/skills/foo.md', '.agents/README.md', 'src/a.ts'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@.agents'], 0, 8, { signal: ctrl() });
    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    expect(values.some((v) => v.startsWith('@.agents/'))).toBe(true);
  });

  it('within a category, recency ranks higher than mtime', async () => {
    const files = ['older-recent.ts', 'never-touched-but-new.ts'];
    const provider = new FileMentionProvider(
      [],
      '/repo',
      NO_FD,
      stubGitCache(files, {
        mtimes: { 'older-recent.ts': 1000, 'never-touched-but-new.ts': 9999 },
        recency: ['older-recent.ts'],
      }),
    );
    // Query hits both via fuzzy (they both contain letters from 'nr').
    // Use basename-startswith shared prefix to force cat 0 tie.
    const tied = ['aa-recent.ts', 'aa-newer.ts'];
    const provider2 = new FileMentionProvider(
      [],
      '/repo',
      NO_FD,
      stubGitCache(tied, {
        mtimes: { 'aa-recent.ts': 1000, 'aa-newer.ts': 9999 },
        recency: ['aa-recent.ts'],
      }),
    );
    const result = await provider2.getSuggestions(['@aa'], 0, 3, { signal: ctrl() });
    const values = result!.items.map((i) => i.value);
    expect(values[0]).toBe('@aa-recent.ts');
    expect(values[1]).toBe('@aa-newer.ts');
    void provider; // silence unused
  });

  it('scoped @src/ limits to files under src/', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'lib/c.ts'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    const result = await provider.getSuggestions(['@src/'], 0, 5, { signal: ctrl() });
    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    // Empty query after src/ shouldn't match lib/c.ts via basename ranking;
    // but our git-backed path doesn't apply scope directly — the query is
    // "src/" and we fall back to fuzzy on the raw path. Both src/ paths
    // contain "src/" and rank higher than lib/c.ts.
    expect(values[0]).toMatch(/^@src\//);
    expect(values[1]).toMatch(/^@src\//);
  });

  it('does not trigger the @ branch when @ is preceded by a non-delimiter', async () => {
    // "email@example" — @ is not at a token boundary; our extractAtPrefix
    // returns null and the inner provider handles the text.
    const provider = new FileMentionProvider([], '/nonexistent', NO_FD, stubGitCache(['a.ts']));
    const result = await provider.getSuggestions(['email@example'], 0, 13, { signal: ctrl() });
    // Inner provider returns null for this kind of free text.
    expect(result).toBeNull();
  });

  it('handles multiple @ mentions on one line by completing the last one', async () => {
    const files = ['alpha.ts', 'beta.ts'];
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(files));
    // "read @alpha.ts and @bet" — cursor at end, inside the second @.
    const line = 'read @alpha.ts and @bet';
    const result = await provider.getSuggestions([line], 0, line.length, { signal: ctrl() });
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('@bet');
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@beta.ts');
    expect(values).not.toContain('@alpha.ts');
  });

  it('applyCompletion delegates to inner (replaces prefix with value)', () => {
    const provider = new FileMentionProvider([], '/repo', NO_FD, stubGitCache(['src/a.ts']));
    const out = provider.applyCompletion(
      ['hey @src'],
      0,
      8, // cursor just after @src
      { value: '@src/a.ts', label: 'a.ts' },
      '@src',
    );
    // pi-tui appends a trailing space after a non-directory completion
    // so the user can type the next token immediately.
    expect(out.lines[0]).toBe('hey @src/a.ts ');
  });

  it('falls through to inner when the git cache is null (non-git dir)', async () => {
    const provider = new FileMentionProvider([], '/nonexistent', NO_FD, stubGitCache(null));
    // No files visible via readdir either, but it shouldn't throw.
    const result = await provider.getSuggestions(['@foo'], 0, 4, { signal: ctrl() });
    // pi-tui readdir on a nonexistent basePath returns [] → null.
    expect(result).toBeNull();
  });
});
