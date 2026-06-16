import { execFile } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  getReviewScopeSummary,
  listReviewBaseRefs,
  listReviewCommits,
  previewReviewTarget,
  resolveReviewTarget,
} from '../../src/review/git-target';
import { readDiffForTarget } from '../../src/tools/builtin/review/support';
import { testKaos } from '../fixtures/test-kaos';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';

const execFileAsync = promisify(execFile);

describe('review git target resolver', () => {
  it('previews working tree renames, deleted files, and untracked files', async () => {
    await withGitRepo(async (repo) => {
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src/rename-me.ts'), numberedLines('old', 10));
      await writeFile(join(repo, 'src/delete-me.ts'), 'delete me\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'initial files');

      await git(repo, 'mv', 'src/rename-me.ts', 'src/renamed.ts');
      await writeFile(join(repo, 'src/renamed.ts'), `${numberedLines('old', 10)}extra\n`);
      await rm(join(repo, 'src/delete-me.ts'));
      await writeFile(join(repo, 'src/untracked.ts'), 'first\nsecond\n');

      const stats = await previewReviewTarget(testKaos.withCwd(repo), { scope: 'working_tree' });
      const files = new Map(stats.files.map((file) => [file.path, file]));

      expect(stats.fileCount).toBe(3);
      expect(files.get('src/renamed.ts')).toMatchObject({
        status: 'renamed',
        oldPath: 'src/rename-me.ts',
        additions: 1,
        deletions: 0,
      });
      expect(files.get('src/delete-me.ts')).toMatchObject({
        status: 'deleted',
        additions: 0,
        deletions: 1,
      });
      expect(files.get('src/untracked.ts')).toMatchObject({
        status: 'untracked',
        additions: 2,
        deletions: 0,
      });
      expect(stats.additions).toBe(3);
      expect(stats.deletions).toBe(1);
    });
  });

  it('keeps working tree patch reads anchored to the resolved base commit', async () => {
    await withGitRepo(async (repo) => {
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src/a.ts'), 'base\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base');
      const baseCommit = await gitOutput(repo, 'rev-parse', 'HEAD');

      await writeFile(join(repo, 'src/a.ts'), 'base\nchanged\n');
      const kaos = testKaos.withCwd(repo);
      const target = await resolveReviewTarget(kaos, { scope: 'working_tree' });
      const stats = await previewReviewTarget(kaos, target);

      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'move head during review');

      const diff = await readDiffForTarget(
        kaos,
        {
          target,
          intensity: 'standard',
          stats,
          startedAt: Date.now(),
        },
        'src/a.ts',
        3,
      );

      expect(target).toMatchObject({ scope: 'working_tree', baseRef: baseCommit });
      expect(diff.hunks).toHaveLength(1);
      expect(diff.patch).toContain('+changed');
    });
  }, 15_000);

  it('resolves the current branch against a selected base ref', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'feature.ts'), 'base\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base');
      await git(repo, 'switch', '-c', 'feature');
      await writeFile(join(repo, 'feature.ts'), 'base\nfeature\n');
      await git(repo, 'commit', '-am', 'feature change');

      const target = await resolveReviewTarget(testKaos.withCwd(repo), {
        scope: 'current_branch',
        baseRef: 'main',
      });
      const stats = await previewReviewTarget(testKaos.withCwd(repo), target);

      expect(target).toMatchObject({
        scope: 'current_branch',
        baseRef: expect.stringMatching(/^[0-9a-f]{40}$/),
        headRef: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(stats.files).toEqual([
        {
          path: 'feature.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
        },
      ]);
    });
  });

  it('separates selected refs from git options when resolving targets', async () => {
    const exec = vi.fn(async (...args: string[]) => {
      const gitArgs = args.slice(3);
      if (gitArgs.join(' ') === 'rev-parse --is-inside-work-tree') {
        return processWithOutput('true\n');
      }
      if (
        gitArgs[0] === 'rev-parse' &&
        gitArgs[1] === '--verify' &&
        gitArgs[2] === '--quiet' &&
        gitArgs[3] === '--end-of-options'
      ) {
        return processWithOutput('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
      }
      throw new Error(`unexpected git command: ${gitArgs.join(' ')}`);
    });

    const target = await resolveReviewTarget(createFakeKaos({
      getcwd: () => '/workspace',
      exec,
    }), {
      scope: 'single_commit',
      commit: '--upload-pack=malicious',
    });

    expect(target).toEqual({
      scope: 'single_commit',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(exec).toHaveBeenCalledWith(
      'git',
      '-C',
      '/workspace',
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      '--upload-pack=malicious^{commit}',
    );
  });

  it('previews only the selected single commit', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'a1\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base');

      await writeFile(join(repo, 'a.ts'), 'a1\na2\n');
      await git(repo, 'commit', '-am', 'second');
      const secondCommit = await gitOutput(repo, 'rev-parse', 'HEAD');

      await writeFile(join(repo, 'b.ts'), 'b1\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'third');

      const target = await resolveReviewTarget(testKaos.withCwd(repo), {
        scope: 'single_commit',
        commit: secondCommit,
      });
      const stats = await previewReviewTarget(testKaos.withCwd(repo), target);

      expect(stats.files).toEqual([
        {
          path: 'a.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
        },
      ]);
    });
  });

  it('lists branches, tags, and recent commits for selectors', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'a\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base commit');
      await git(repo, 'tag', 'v1');
      await git(repo, 'switch', '-c', 'feature');
      await writeFile(join(repo, 'a.ts'), 'a\nb\n');
      await git(repo, 'commit', '-am', 'feature commit');

      const refs = await listReviewBaseRefs(testKaos.withCwd(repo));
      const commits = await listReviewCommits(testKaos.withCwd(repo));

      expect(refs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'main', kind: 'branch' }),
          expect.objectContaining({ name: 'feature', kind: 'branch' }),
          expect.objectContaining({ name: 'v1', kind: 'tag' }),
          expect.objectContaining({ kind: 'commit', description: 'feature commit' }),
        ]),
      );
      expect(commits[0]).toMatchObject({
        title: 'feature commit',
        author: 'Review Test',
      });
    });
  });

  it('includes per-commit shortstat and body presence in the commit list', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'a\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base commit');

      await writeFile(join(repo, 'a.ts'), 'a\nb\nc\n');
      await writeFile(join(repo, 'b.ts'), 'new\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'second commit', '-m', 'with an explanatory body');

      const commits = await listReviewCommits(testKaos.withCwd(repo));

      expect(commits[0]).toMatchObject({
        title: 'second commit',
        filesChanged: 2,
        additions: 3,
        deletions: 0,
        hasBody: true,
      });
      expect(commits[1]).toMatchObject({
        title: 'base commit',
        filesChanged: 1,
        additions: 1,
        hasBody: false,
      });
    });
  });

  it('summarizes review scope context for the first selector', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'base\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base commit');
      const mainCommit = await gitOutput(repo, 'rev-parse', 'HEAD');

      await git(repo, 'switch', '-c', 'feature');
      await git(repo, 'branch', '--set-upstream-to', 'main');
      await writeFile(join(repo, 'feature.ts'), 'feature\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'feature commit');
      const featureCommit = await gitOutput(repo, 'rev-parse', 'HEAD');
      const shortFeatureCommit = await gitOutput(repo, 'rev-parse', '--short', 'HEAD');

      await writeFile(join(repo, 'staged.ts'), 'staged\n');
      await git(repo, 'add', 'staged.ts');
      await writeFile(join(repo, 'a.ts'), 'base\nunstaged\n');
      await writeFile(join(repo, 'untracked.ts'), 'untracked\n');

      const summary = await getReviewScopeSummary(testKaos.withCwd(repo));

      expect(summary.workingTree).toEqual({
        stagedCount: 1,
        unstagedCount: 1,
        untrackedCount: 1,
        conflictedCount: 0,
      });
      expect(summary.head).toEqual({
        sha: featureCommit,
        shortSha: shortFeatureCommit,
        subject: 'feature commit',
      });
      expect(summary.upstream).toEqual({
        upstreamRef: 'main',
        upstreamCommit: mainCommit,
        headCommit: featureCommit,
        aheadCount: 1,
        behindCount: 0,
      });
    });
  });

  it('omits upstream summary when the branch has no upstream', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'base\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base commit');

      const summary = await getReviewScopeSummary(testKaos.withCwd(repo));

      expect(summary.upstream).toBeNull();
    });
  });

  it('bounds untracked file reads while previewing the working tree', async () => {
    const readBytes = vi.fn(async (_path: string, _n?: number) => Buffer.from('first\nsecond\n'));
    const exec = vi.fn(async (...args: string[]) => {
      const gitArgs = args.slice(3);
      if (gitArgs.join(' ') === 'rev-parse --is-inside-work-tree') {
        return processWithOutput('true\n');
      }
      if (gitArgs.includes('--name-status')) return processWithOutput('');
      if (gitArgs.includes('--numstat')) return processWithOutput('');
      if (gitArgs.join(' ') === 'ls-files --others --exclude-standard -z') {
        return processWithOutput('large.sql\0');
      }
      throw new Error(`unexpected git command: ${gitArgs.join(' ')}`);
    });
    const stats = await previewReviewTarget(createFakeKaos({
      getcwd: () => '/workspace',
      exec,
      readBytes,
    }), { scope: 'working_tree' });

    const readLimit = readBytes.mock.calls[0]?.[1];
    expect(readLimit).toEqual(expect.any(Number));
    expect(readLimit).toBeGreaterThan(0);
    expect(readLimit).toBeLessThanOrEqual(1024 * 1024);
    expect(stats.files).toEqual([
      {
        path: 'large.sql',
        status: 'untracked',
        additions: 2,
        deletions: 0,
      },
    ]);
  });

  it('keeps HEAD metadata and omits upstream in detached HEAD state', async () => {
    await withGitRepo(async (repo) => {
      await writeFile(join(repo, 'a.ts'), 'base\n');
      await git(repo, 'add', '.');
      await git(repo, 'commit', '-m', 'base commit');
      const sha = await gitOutput(repo, 'rev-parse', 'HEAD');
      const shortSha = await gitOutput(repo, 'rev-parse', '--short', 'HEAD');
      await git(repo, 'switch', '--detach', 'HEAD');

      const summary = await getReviewScopeSummary(testKaos.withCwd(repo));

      expect(summary.head).toEqual({
        sha,
        shortSha,
        subject: 'base commit',
      });
      expect(summary.upstream).toBeNull();
    });
  });
});

async function withGitRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-review-git-'));
  try {
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'review@example.test');
    await git(repo, 'config', 'user.name', 'Review Test');
    await run(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function git(repo: string, ...args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd: repo });
}

async function gitOutput(repo: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd: repo });
  return stdout.trim();
}

function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_value, index) => `${prefix}-${String(index)}\n`).join('');
}

function processWithOutput(stdout: string) {
  return {
    stdin: new PassThrough(),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([]),
    pid: 1,
    exitCode: null,
    wait: vi.fn(async () => 0),
    kill: vi.fn(async () => {}),
  };
}
