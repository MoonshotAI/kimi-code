import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  listReviewBaseRefs,
  listReviewCommits,
  previewReviewTarget,
  resolveReviewTarget,
} from '../../src/review/git-target';
import { testKaos } from '../fixtures/test-kaos';

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
