import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export interface GitWorktreeLayout {
  readonly main: string;
  readonly worktree: string;
}

export async function createGitWorktree(base: string): Promise<GitWorktreeLayout> {
  const main = join(base, 'app');
  const worktree = join(base, 'app-fix');
  const exec = promisify(execFile);
  await mkdir(main);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: main });
  await exec(
    'git',
    ['-c', 'user.email=worktree-test@example.com', '-c', 'user.name=Worktree Test', 'commit', '-q', '--allow-empty', '-m', 'initial'],
    { cwd: main },
  );
  await exec('git', ['worktree', 'add', '-q', '-b', 'fix', worktree], { cwd: main });
  return { main, worktree };
}
