import { describe, expect, it } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '../src/lib/filePathLinks';
import { parseDiff } from '../src/lib/parseDiff';
import { normalizeToolName, toolSummary } from '../src/lib/toolMeta';
import { mergeWorktreeGroups } from '../src/lib/worktreeGroups';
import { createCoalescedAsyncRunner } from '../src/lib/snapshotSync';
import type { AppWorktree } from '../src/api/types';
import type { WorktreeGroup, WorkspaceView } from '../src/types';

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

function workspace(id: string, isGitRepo: boolean): WorkspaceView {
  return {
    id,
    name: `repo-${id}`,
    root: `/repos/${id}`,
    shortPath: `~/repos/${id}`,
    sessionCount: 0,
    isGitRepo,
  };
}

function worktree(branch: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return {
    path: `/repos/wt-${branch || 'detached'}`,
    branch,
    head: 'abc123',
    isMain: false,
    locked: false,
    prunable: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    sessionId: null,
    pullRequest: null,
    ...overrides,
  };
}

function group(key: string, overrides: Partial<WorktreeGroup> = {}): WorktreeGroup {
  return {
    key,
    workspaceId: key.split(':')[0] ?? '',
    workspaceName: 'repo',
    branch: key.split(':')[1] ?? '',
    isMain: false,
    path: '/repos/session-cwd',
    dirty: false,
    pullRequest: null,
    sessions: [],
    hasRunning: false,
    hasPending: false,
    latestAt: 100,
    ...overrides,
  };
}

describe('mergeWorktreeGroups', () => {
  it('adds an empty worktree as a sidebar group so it can be opened', () => {
    const ws = workspace('w1', true);
    const result = mergeWorktreeGroups([], [ws], {
      w1: [worktree('feature', { isMain: false, pullRequest: { number: 7, state: 'open', url: 'u' } })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'w1:feature',
      workspaceId: 'w1',
      branch: 'feature',
      isMain: false,
      path: '/repos/wt-feature',
      sessions: [],
      hasRunning: false,
      hasPending: false,
      latestAt: 0,
      pullRequest: { number: 7, state: 'open', url: 'u' },
    });
  });

  it('enriches an existing session group instead of duplicating it', () => {
    const ws = workspace('w1', true);
    const existing = group('w1:main', { path: '/old', dirty: false, pullRequest: null });
    const result = mergeWorktreeGroups([existing], [ws], {
      w1: [worktree('main', { isMain: true, dirty: true, path: '/repos/main' })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: 'w1:main',
      path: '/repos/main',
      isMain: true,
      dirty: true,
      latestAt: 100,
    });
  });

  it('keeps a session-derived pull request when the worktree has none', () => {
    const ws = workspace('w1', true);
    const pr = { number: 3, state: 'open', url: 'pr' };
    const existing = group('w1:main', { pullRequest: pr });
    const result = mergeWorktreeGroups([existing], [ws], {
      w1: [worktree('main', { pullRequest: null })],
    });
    expect(result[0]?.pullRequest).toBe(pr);
  });

  it('ignores non-git workspaces and workspaces whose worktrees are not loaded', () => {
    const nonGit = workspace('w2', false);
    const gitNotLoaded = workspace('w3', true);
    const result = mergeWorktreeGroups([], [nonGit, gitNotLoaded], {
      // w3 intentionally absent → not loaded yet
      w2: [worktree('x')],
    });
    expect(result).toHaveLength(0);
  });

  it('does not mutate the input groups or array', () => {
    const ws = workspace('w1', true);
    const existing = group('w1:main', { path: '/old', dirty: false });
    const groups = [existing];
    const result = mergeWorktreeGroups(groups, [ws], {
      w1: [worktree('main', { path: '/new', dirty: true })],
    });
    expect(result).not.toBe(groups);
    expect(existing.path).toBe('/old');
    expect(existing.dirty).toBe(false);
  });
});

describe('createCoalescedAsyncRunner', () => {
  it('reuses the in-flight promise for the same key', async () => {
    let runs = 0;
    let resolveRun!: () => void;
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return runs;
    });

    const first = runner.run('session-a');
    const second = runner.run('session-a');

    expect(runs).toBe(1);
    resolveRun();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(runs).toBe(1);
  });

  it('queues at most one rerun requested while a run is in flight', async () => {
    let runs = 0;
    const resolvers: Array<() => void> = [];
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return runs;
    });

    const first = runner.run('session-a');
    runner.request('session-a');
    runner.request('session-a');
    expect(runs).toBe(1);

    resolvers[0]!();
    await first;
    await Promise.resolve();

    expect(runs).toBe(2);
    resolvers[1]!();
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});
