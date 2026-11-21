import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COMMIT_SETTINGS = [
  '-c',
  'user.email=testkit@example.com',
  '-c',
  'user.name=Testkit',
  '-c',
  'commit.gpgsign=false',
] as const;

export interface GitRepositoryOptions {
  readonly files?: Readonly<Record<string, string>>;
}

export interface GitWorktreeLayout {
  readonly main: string;
  readonly worktree: string;
}

export async function createGitRepository(dir: string, options: GitRepositoryOptions = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, ...COMMIT_SETTINGS, 'commit', '-q', '--allow-empty', '-m', 'initial');
  return dir;
}

export async function createGitWorktree(
  layout: GitWorktreeLayout,
  options: GitRepositoryOptions = {},
): Promise<GitWorktreeLayout> {
  await createGitRepository(layout.main, options);
  await git(layout.main, 'worktree', 'add', '-q', '-b', 'fix', layout.worktree);
  return layout;
}

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd });
}
