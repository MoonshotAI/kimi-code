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
  readonly branches?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface GitWorktreeLayout {
  readonly main: string;
  readonly worktree: string;
}

export async function createGitRepository(dir: string, options: GitRepositoryOptions = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFiles(dir, options.files ?? {});
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, ...COMMIT_SETTINGS, 'commit', '-q', '--allow-empty', '-m', 'initial');
  for (const [branch, files] of Object.entries(options.branches ?? {})) {
    await git(dir, 'checkout', '-q', '-b', branch);
    await writeFiles(dir, files);
    await git(dir, 'add', '-A');
    await git(dir, ...COMMIT_SETTINGS, 'commit', '-q', '--allow-empty', '-m', branch);
    await git(dir, 'checkout', '-q', 'main');
  }
  return dir;
}

export async function runGit(dir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...COMMIT_SETTINGS, ...args], { cwd: dir });
  return stdout;
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

async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

export function bashPathOf(nativePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return nativePath;
  const slashed = nativePath.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\//.exec(slashed);
  return drive === null ? slashed : `/${drive[1]!.toLowerCase()}${slashed.slice(2)}`;
}
