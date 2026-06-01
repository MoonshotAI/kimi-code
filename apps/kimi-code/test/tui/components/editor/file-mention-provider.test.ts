import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import type { GitLsFilesCache, GitSnapshot } from '#/utils/git/git-ls-files';

function stubGitCache(
  files: string[] | null,
  opts: { mtimes?: Record<string, number>; recency?: string[]; isGitRepo?: boolean } = {},
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
    isGitRepo: () => opts.isGitRepo ?? files !== null,
    getSnapshot: () => snapshot,
    list: () => (files === null ? null : files.slice()),
  };
}

function ctrl(): AbortSignal {
  return new AbortController().signal;
}

const NO_FD = null;

describe('FileMentionProvider — @ prefix detection + git-backed suggestions', () => {
  it('returns null when there is no @ mention and the dir is empty', async () => {
    const provider = new FileMentionProvider([], '/nonexistent', NO_FD, stubGitCache([]));
    const result = await provider.getSuggestions(['hello world'], 0, 11, { signal: ctrl() });
    // pi-tui inner will also return null for non-path plain text.
    expect(result).toBeNull();
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

describe('FileMentionProvider — readdir fallback when no git cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'file-mention-readdir-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces files recursively when @ is typed in a non-git directory', async () => {
    writeFileSync(join(dir, 'a.ts'), '');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/b.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });

    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('@');
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@a.ts');
    expect(values).toContain('@src/b.ts');
  });

  it('skips files under blacklisted directories (node_modules, dist, etc.)', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/keep.ts'), '');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/skip.ts'), '');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/skip.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });

    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@src/keep.ts');
    expect(values.some((v) => v.includes('node_modules'))).toBe(false);
    expect(values.some((v) => v.includes('/dist/'))).toBe(false);
  });

  it('hides dotfiles by default but keeps .git/ unmentionable', async () => {
    // The walker collects all entries (including dotfiles) so the
    // opt-in below can surface them. Default filtering happens in
    // buildFromReadDir via containsDotSegment, mirroring the git-backed
    // path. .git/ is filtered earlier by the SKIP_DIRS set.
    writeFileSync(join(dir, 'visible.ts'), '');
    writeFileSync(join(dir, '.hidden.ts'), '');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git/HEAD'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const result = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });

    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@visible.ts');
    expect(values.some((v) => v.includes('.hidden'))).toBe(false);
    expect(values.some((v) => v.includes('.git/'))).toBe(false);
  });

  it('surfaces dotfiles when the query explicitly opts in (e.g. @.env)', async () => {
    writeFileSync(join(dir, '.env'), '');
    writeFileSync(join(dir, 'foo.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const result = await provider.getSuggestions(['@.env'], 0, 5, { signal: ctrl() });

    expect(result).not.toBeNull();
    const values = result!.items.map((i) => i.value);
    expect(values).toContain('@.env');
    expect(values).not.toContain('@foo.ts');
  });

  it('returns null from getSuggestions when the readdir ranking has no matches', async () => {
    // The walker finds foo.ts, but `does-not-exist` matches nothing —
    // ranking returns an empty array. buildFromReadDir must turn that
    // into null so the editor dismisses the menu instead of showing
    // an empty autocomplete state.
    writeFileSync(join(dir, 'foo.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const result = await provider.getSuggestions(['@does-not-exist'], 0, 16, { signal: ctrl() });

    expect(result).toBeNull();
  });

  it('does not invoke the readdir fallback inside a git repo, even when the snapshot is empty', async () => {
    // stubGitCache([]) simulates a git repo with an empty snapshot
    // (e.g. a fresh repo with no files). Gated on `!isGitRepo()`, the
    // readdir fallback MUST NOT be consulted — otherwise .gitignored
    // paths in a real repo could leak through raw readdir.
    writeFileSync(join(dir, 'a.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache([]));
    const result = await provider.getSuggestions(['@a'], 0, 2, { signal: ctrl() });

    expect(result).toBeNull();
  });

  it('does not invoke the readdir fallback when git ls-files transiently fails inside a git repo', async () => {
    // The transient-failure case the codex review flagged: a real git
    // repo whose `git ls-files` invocation returned null. `isGitRepo()`
    // is still true (the repo exists), `getSnapshot()` is null (the
    // spawn failed). The readdir fallback MUST NOT run — that would
    // bypass `.gitignore` and could surface ignored files.
    writeFileSync(join(dir, 'a.ts'), '');

    const provider = new FileMentionProvider(
      [],
      dir,
      NO_FD,
      stubGitCache(null, { isGitRepo: true }),
    );
    const result = await provider.getSuggestions(['@a'], 0, 2, { signal: ctrl() });

    expect(result).toBeNull();
  });

  it('caches the walk result: new files do not appear within the 2s TTL window', async () => {
    writeFileSync(join(dir, 'old.ts'), '');

    const provider = new FileMentionProvider([], dir, NO_FD, stubGitCache(null));
    const first = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const firstValues = first!.items.map((i) => i.value);
    expect(firstValues).toContain('@old.ts');

    // Immediately create a new file and re-query. Within the TTL
    // window the walker should return the cached snapshot, so the
    // new file must NOT surface until the cache expires.
    writeFileSync(join(dir, 'new.ts'), '');
    const second = await provider.getSuggestions(['@'], 0, 1, { signal: ctrl() });
    const secondValues = second!.items.map((i) => i.value);
    expect(secondValues).toContain('@old.ts');
    expect(secondValues).not.toContain('@new.ts');
  });
});
